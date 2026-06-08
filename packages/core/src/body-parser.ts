// @celsian/core -- Body parsing with content-type detection and streaming size limits

import { HttpError } from "./errors.js";
import type { CelsianRequest } from "./types.js";

// Keys that must never be set via user input (prototype pollution prevention)
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

/**
 * Read the request body as text, enforcing a byte limit during streaming.
 * Rejects with 413 if the body exceeds the limit before reading completes.
 */
export async function readBodyText(request: Request, limit: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > limit) {
    throw new HttpError(413, "Payload Too Large");
  }

  if (!request.body || limit <= 0) {
    return request.text();
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        throw new HttpError(413, "Payload Too Large");
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
    throw new HttpError(413, "Payload Too Large");
  }

  if (!request.body) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > limit) {
      throw new HttpError(413, "Payload Too Large");
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
        throw new HttpError(413, "Payload Too Large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

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
 * Parse the request body based on Content-Type header.
 * Supports JSON, form-urlencoded, multipart, and plain text.
 * Skips parsing for GET/HEAD or missing Content-Type.
 */
export async function parseBody(
  request: CelsianRequest,
  bodyLimit: number,
  contentTypeParsers: Map<string, (request: Request) => Promise<unknown>>,
): Promise<void> {
  const contentType = request.headers.get("content-type") ?? "";

  if (request.method === "GET" || request.method === "HEAD") {
    return;
  }

  // Check custom content-type parsers (exact match then prefix match)
  if (contentTypeParsers.size > 0) {
    for (const [registeredType, parser] of contentTypeParsers) {
      if (contentType === registeredType || contentType.startsWith(registeredType)) {
        request.parsedBody = await parser(request);
        return;
      }
    }
  }

  try {
    if (contentType.includes("application/json")) {
      try {
        const text = await readBodyText(request, bodyLimit);
        if (!text.trim()) return;
        request.parsedBody = scrubPrototypePollution(JSON.parse(text));
      } catch (parseErr) {
        if (parseErr instanceof HttpError) throw parseErr;
        throw new HttpError(400, `Invalid JSON (content-type: ${contentType}): ${(parseErr as Error).message}`, {
          code: "INVALID_JSON",
          cause: parseErr as Error,
        });
      }
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      request.parsedBody = await parseFormData(request, bodyLimit);
    } else if (contentType.includes("text/")) {
      request.parsedBody = await readBodyText(request, bodyLimit);
    } else if (!contentType) {
      // No Content-Type header — skip parsing.
      // Callers must set Content-Type to get automatic body parsing.
      return;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // Surface parse failures (malformed form/multipart, etc.) as a 400 instead
    // of swallowing them and letting the handler run with an undefined body.
    throw new HttpError(400, `Failed to parse request body (content-type: ${contentType}): ${(e as Error).message}`, {
      code: "INVALID_BODY",
      cause: e as Error,
    });
  }
}
