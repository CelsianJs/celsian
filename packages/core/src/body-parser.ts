// @celsian/core -- Body parsing with content-type detection and streaming size limits

import { HttpError } from "./errors.js";
import { type NodeBodyStream, takeNodeBody } from "./request.js";
import type { CelsianRequest } from "./types.js";

/**
 * Keys that must never be set via user input (prototype pollution prevention).
 * Shared so every user-controlled key/value map in core rejects the same set.
 */
export const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Actionable 413: names the byte limit and the config key that raises it. */
function payloadTooLarge(limit: number, actual?: number): HttpError {
  const seen = actual === undefined ? "" : ` (received at least ${actual} bytes)`;
  return new HttpError(
    413,
    `Payload Too Large: request body exceeds the ${limit} byte limit${seen}. ` +
      `Raise it with createApp({ bodyLimit: <bytes> }) or lower the payload size.`,
  );
}

/**
 * Recursively strip dangerous keys (`__proto__`, `constructor`, `prototype`)
 * from a parsed JSON value to prevent prototype pollution. Returns a sanitized
 * copy: plain objects are rebuilt with a null prototype, arrays are mapped.
 */
function scrubPrototypePollution(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubPrototypePollution);
  }
  if (value !== null && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (BLOCKED_KEYS.has(key)) continue;
      clean[key] = scrubPrototypePollution((value as Record<string, unknown>)[key]);
    }
    return clean;
  }
  return value;
}

/** Decodes a body that arrived in one piece. Never used with `stream: true`, so it holds no state between calls. */
const WHOLE_BODY_DECODER = new TextDecoder();

/**
 * Read a Node request stream to its end, enforcing `limit` as the bytes arrive.
 * Resolves with what `finish` makes of the chunks, in order; rejects with a
 * 413 as soon as the limit is passed, with the stream's own error if the
 * client goes away first, and with whatever `finish` throws. `explain`, when
 * given, turns any of those into the error to reject with.
 *
 * This is the same contract as the reader loops below, on the stream the bytes
 * actually come from: one promise for the whole body instead of several per
 * chunk in the web stream wrapped around it. `finish` runs in the stream's own
 * "end" callback, so decoding and parsing the body need no promise of their own.
 */
function readNodeBody<T>(
  stream: NodeBodyStream,
  limit: number,
  finish: (chunks: Uint8Array[]) => T,
  explain?: (error: unknown) => unknown,
): Promise<T> {
  return new Promise((resolve, rejectWith) => {
    const reject = explain === undefined ? rejectWith : (error: unknown) => rejectWith(explain(error));
    if (stream.readableEnded) {
      try {
        resolve(finish([]));
      } catch (error) {
        reject(error);
      }
      return;
    }
    if (stream.destroyed) {
      reject(new Error("aborted"));
      return;
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const stop = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onData = (chunk: Uint8Array) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > limit) {
        // Stop reading, as the web reader did when it released its lock mid-stream.
        stop();
        stream.pause();
        reject(payloadTooLarge(limit, totalBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      stop();
      try {
        resolve(finish(chunks));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      stop();
      reject(error);
    };
    // 'close' without 'end': the client went away mid-body.
    const onClose = () => {
      stop();
      reject(new Error("aborted"));
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.on("close", onClose);
  });
}

/**
 * Throw the 413 when `request` declares a body longer than `limit`. Reads the
 * Content-Length header once. Only for a real limit (above 0).
 */
function checkDeclaredLength(request: Request | CelsianRequest, limit: number): void {
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > limit) {
    throw payloadTooLarge(limit, parseInt(contentLength, 10));
  }
}

/**
 * Read the request body as text, enforcing a byte limit during streaming.
 * Rejects with 413 if the body exceeds the limit before reading completes.
 */
export async function readBodyText(request: Request, limit: number): Promise<string> {
  // A limit of 0 means no limit, so a declared length is only held against a
  // real one. Checked unconditionally, `bodyLimit: 0` refused every body that
  // declared its length, which is nearly every body, with a 413.
  if (limit > 0) checkDeclaredLength(request, limit);
  return readCheckedBodyText(request, limit);
}

/** {@link readBodyText} once the declared length has been checked. */
function readCheckedBodyText(request: Request, limit: number): Promise<string> {
  // On core's Node server, read the Node stream itself rather than the web
  // stream wrapped around it. Same bytes, same limit, same decoding.
  const nodeBody = limit > 0 ? takeNodeBody(request) : undefined;
  if (nodeBody !== undefined) return readNodeBody(nodeBody, limit, decodeChunks);

  if (!request.body || limit <= 0) {
    return request.text();
  }
  return readWebBodyText(request.body, limit);
}

/** Read a web stream to its end as UTF-8 text, rejecting with a 413 once it passes `limit`. */
async function readWebBodyText(body: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        throw payloadTooLarge(limit, totalBytes);
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return result;
}

/**
 * Read the request body into a Uint8Array, enforcing a byte limit during
 * streaming. Rejects with 413 if the body exceeds the limit. Used to cap
 * multipart/urlencoded bodies before handing them to formData().
 */
async function readBodyBytes(request: Request, limit: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > limit) {
    throw payloadTooLarge(limit, parseInt(contentLength, 10));
  }

  // See readBodyText: the Node stream itself, when core's Node server offers it.
  const nodeBody = takeNodeBody(request);
  if (nodeBody !== undefined) return readNodeBody(nodeBody, limit, joinChunks);

  if (!request.body) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > limit) {
      throw payloadTooLarge(limit, buf.byteLength);
    }
    return new Uint8Array(buf);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        throw payloadTooLarge(limit, totalBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return joinChunks(chunks, totalBytes);
}

/** The text of a body that arrived as `chunks`: UTF-8, a byte order mark dropped, as `Request.text()` decodes it. */
function decodeChunks(chunks: Uint8Array[]): string {
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return WHOLE_BODY_DECODER.decode(chunks[0]);
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/** Copy `chunks` into one array of their combined length. */
function joinChunks(
  chunks: Uint8Array[],
  totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Parse multipart/urlencoded form data while enforcing the byte limit.
 * Buffers the body (capped) and reconstructs a Request so formData() runs
 * against the bounded payload, returning 413 for oversized bodies.
 */
async function parseFormData(request: CelsianRequest, bodyLimit: number): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";

  // When no limit is configured, defer to the native parser.
  if (bodyLimit <= 0) {
    return request.formData();
  }

  const bytes = await readBodyBytes(request, bodyLimit);
  const reconstructed = new Request(request.url, {
    method: request.method,
    headers: { "content-type": contentType },
    body: bytes,
  });
  return reconstructed.formData();
}

/**
 * Enforce the bodyLimit for custom content-type parsers: read the body through
 * the capped reader (throws 413 HttpError on overflow), then rebuild a Request
 * with the bounded bytes so the parser's `text()`/`json()`/`arrayBuffer()` etc.
 * all operate on capped data. With no limit (<= 0), the original request is
 * handed through untouched.
 */
async function capRequestBody(request: CelsianRequest, bodyLimit: number): Promise<Request> {
  if (bodyLimit <= 0) {
    return request as unknown as Request;
  }
  const bytes = await readBodyBytes(request as unknown as Request, bodyLimit);
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
  });
}

/** A parser registered with `app.addContentTypeParser()`. */
type ContentTypeParser = (request: Request) => Promise<unknown>;

/**
 * Parse the request body based on Content-Type header.
 * Supports JSON, form-urlencoded, multipart, and plain text.
 * Skips parsing for GET/HEAD or missing Content-Type.
 */
export async function parseBody(
  request: CelsianRequest,
  bodyLimit: number,
  contentTypeParsers: Map<string, ContentTypeParser>,
): Promise<void> {
  await parseBodyIfAny(request, bodyLimit, contentTypeParsers);
}

/**
 * {@link parseBody} that stays synchronous when there is nothing to parse.
 *
 * Returns `undefined`, without creating a promise, for GET and HEAD and for a
 * content type no parser handles (a missing one included). That is every
 * request that has no body to read, so a lifecycle with no other asynchronous
 * step can answer in the same tick. Otherwise returns the parse in progress.
 */
export function parseBodyIfAny(
  request: CelsianRequest,
  bodyLimit: number,
  contentTypeParsers: Map<string, ContentTypeParser>,
): Promise<void> | undefined {
  const method = request.method;
  if (method === "GET" || method === "HEAD") return undefined;

  const contentType = request.headers.get("content-type") ?? "";

  // Check custom content-type parsers (exact match then prefix match).
  // bodyLimit is enforced for custom parsers too: the body is pre-read through
  // the capped reader (413 on overflow) and the parser receives a reconstructed
  // Request carrying the already-bounded bytes, its body methods are all capped.
  if (contentTypeParsers.size > 0) {
    for (const [registeredType, parser] of contentTypeParsers) {
      if (contentType === registeredType || contentType.startsWith(registeredType)) {
        return parseWithCustomParser(request, bodyLimit, parser);
      }
    }
  }

  if (
    contentType.includes("application/json") ||
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data") ||
    contentType.includes("text/")
  ) {
    return parseBuiltIn(request, bodyLimit, contentType);
  }

  // No Content-Type header, or one nothing here parses: skip parsing.
  // Callers must set Content-Type to get automatic body parsing.
  return undefined;
}

async function parseWithCustomParser(
  request: CelsianRequest,
  bodyLimit: number,
  parser: ContentTypeParser,
): Promise<void> {
  request.parsedBody = await parser(await capRequestBody(request, bodyLimit));
}

/** The 400 for a JSON body that could not be read or parsed. A 413 (any HttpError) passes through. */
function invalidJson(error: unknown, contentType: string): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(400, `Invalid JSON (content-type: ${contentType}): ${(error as Error).message}`, {
    code: "INVALID_JSON",
    cause: error as Error,
  });
}

/** The 400 for any other body that could not be read or parsed. */
function invalidBody(error: unknown, contentType: string): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(
    400,
    `Failed to parse request body (content-type: ${contentType}): ${(error as Error).message}`,
    {
      code: "INVALID_BODY",
      cause: error as Error,
    },
  );
}

/** Parse a JSON, form, multipart or text body. `contentType` is known to be one of them. */
function parseBuiltIn(request: CelsianRequest, bodyLimit: number, contentType: string): Promise<void> {
  const json = contentType.includes("application/json");
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    // A JSON content type that also names a form type is still parsed as JSON.
    if (!json) return parseFormBody(request, bodyLimit, contentType);
  }
  return parseTextBody(request, bodyLimit, contentType, json);
}

/**
 * Parse a JSON or text/* body, the bodies nearly every request with a body
 * has.
 *
 * The declared length is read once, before either stream is touched, and a
 * failure to read it is reported like any other failure to read the body (a
 * 400 INVALID_JSON or INVALID_BODY), as it always was. Then, when core's Node
 * server offers the Node stream, the body is read, decoded and parsed in that
 * stream's "end" callback: one promise for all of it. Otherwise it is read
 * through the Request (`inject()`, the other runtimes' adapters). Same checks
 * in the same order and the same errors either way.
 */
function parseTextBody(request: CelsianRequest, bodyLimit: number, contentType: string, json: boolean): Promise<void> {
  const explain = json
    ? (error: unknown) => invalidJson(error, contentType)
    : (error: unknown) => invalidBody(error, contentType);
  if (bodyLimit > 0) {
    try {
      checkDeclaredLength(request, bodyLimit);
    } catch (error) {
      return Promise.reject(explain(error));
    }
    const nodeBody = takeNodeBody(request);
    if (nodeBody !== undefined) {
      return readNodeBody(
        nodeBody,
        bodyLimit,
        (chunks) => {
          const text = decodeChunks(chunks);
          if (!json) request.parsedBody = text;
          else if (text.trim()) request.parsedBody = scrubPrototypePollution(JSON.parse(text));
        },
        explain,
      );
    }
  }
  return parseTextThroughRequest(request, bodyLimit, json, explain);
}

/** {@link parseTextBody} through the Request, once the declared length has been checked. */
async function parseTextThroughRequest(
  request: CelsianRequest,
  bodyLimit: number,
  json: boolean,
  explain: (error: unknown) => unknown,
): Promise<void> {
  try {
    const text = await readCheckedBodyText(request as unknown as Request, bodyLimit);
    if (!json) request.parsedBody = text;
    else if (text.trim()) request.parsedBody = scrubPrototypePollution(JSON.parse(text));
  } catch (error) {
    throw explain(error);
  }
}

async function parseFormBody(request: CelsianRequest, bodyLimit: number, contentType: string): Promise<void> {
  try {
    request.parsedBody = await parseFormData(request, bodyLimit);
  } catch (e) {
    // Surface parse failures (malformed form/multipart, etc.) as a 400 instead
    // of swallowing them and letting the handler run with an undefined body.
    throw invalidBody(e, contentType);
  }
}
