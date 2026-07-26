// @celsian/compress — Response compression plugin

import type { CelsianReply, CelsianRequest, HookHandler, PluginFunction } from "@celsian/core";

export type CompressionEncoding = "gzip" | "deflate";

/** Decide whether a particular response should be compressed. */
export type CompressFilter = (request: CelsianRequest, reply: CelsianReply, contentType: string) => boolean;

/** Options for the compression plugin. */
export interface CompressOptions {
  /** Minimum response size in BYTES before compression kicks in. Default: 1024. */
  threshold?: number;
  /** Encodings this server is willing to produce, in order of preference. */
  encodings?: CompressionEncoding[];
  /**
   * Per-response opt-out. Receives the request, the reply, and the resolved
   * content-type. Return `false` to send the response uncompressed. Defaults to
   * {@link isCompressibleContentType} — a conservative allow-list of textual
   * types. See the BREACH note in the README before widening it.
   */
  filter?: CompressFilter;
}

const DEFAULT_THRESHOLD = 1024;
const DEFAULT_ENCODINGS: CompressionEncoding[] = ["gzip", "deflate"];

/**
 * Content types worth compressing. Everything else (images, video, archives,
 * already-compressed payloads) is left alone: compressing them wastes CPU and
 * widens the BREACH exposure for no bandwidth gain.
 */
const COMPRESSIBLE_TYPE =
  /^(?:text\/|application\/(?:json|xml|javascript|x-javascript|ld\+json|manifest\+json)|image\/svg\+xml)|(?:\+json|\+xml)(?:\s*;|$)/i;

/** Default {@link CompressFilter} predicate: a conservative textual allow-list. */
export function isCompressibleContentType(contentType: string): boolean {
  return COMPRESSIBLE_TYPE.test(contentType.trim());
}

interface AcceptedEncoding {
  coding: string;
  q: number;
}

/**
 * Parse an `Accept-Encoding` header into (coding, q) pairs.
 *
 * A naive `header.includes('gzip')` treats `gzip;q=0, deflate` — an explicit
 * RFC 9110 refusal of gzip — as a request FOR gzip.
 */
function parseAcceptEncoding(header: string): AcceptedEncoding[] {
  const result: AcceptedEncoding[] = [];
  for (const part of header.split(",")) {
    const [rawCoding, ...params] = part.trim().split(";");
    const coding = rawCoding?.trim().toLowerCase();
    if (!coding) continue;

    let q = 1;
    for (const param of params) {
      const [name, value] = param.split("=");
      if (name?.trim().toLowerCase() === "q") {
        const parsed = Number.parseFloat(value?.trim() ?? "");
        q = Number.isFinite(parsed) ? parsed : 1;
      }
    }
    result.push({ coding, q });
  }
  return result;
}

/**
 * Pick the highest-q encoding the client actually accepts. `q=0` is a refusal
 * and is never selected; ties are broken by the server's preference order.
 */
function negotiateEncoding(acceptEncoding: string, supported: CompressionEncoding[]): CompressionEncoding | null {
  if (!acceptEncoding) return null;
  const accepted = parseAcceptEncoding(acceptEncoding);
  if (accepted.length === 0) return null;

  const wildcard = accepted.find((entry) => entry.coding === "*");
  let best: CompressionEncoding | null = null;
  let bestQ = 0;

  for (const encoding of supported) {
    const explicit = accepted.find((entry) => entry.coding === encoding);
    const q = explicit ? explicit.q : (wildcard?.q ?? 0);
    if (q > bestQ) {
      best = encoding;
      bestQ = q;
    }
  }

  return bestQ > 0 ? best : null;
}

/** Append `accept-encoding` to a Vary value without duplicating it. */
function withVaryAcceptEncoding(existing: string | undefined): string {
  if (!existing) return "accept-encoding";
  const fields = existing
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (fields.some((field) => field.toLowerCase() === "accept-encoding")) return fields.join(", ");
  return [...fields, "accept-encoding"].join(", ");
}

/**
 * Copy an already-built Response's headers, preserving REPEATED `Set-Cookie`.
 *
 * `new Headers(response.headers)` collapses multiple Set-Cookie values into one
 * comma-joined header, which browsers reject. `getSetCookie()` is the only way
 * to read them back individually.
 */
function copyHeadersPreservingCookies(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers.append(key, value);
  });
  for (const cookie of source.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return headers;
}

/** Stream `body` through a CompressionStream, never leaking an unhandled rejection. */
function compressStream(body: string, encoding: CompressionEncoding): ReadableStream<Uint8Array> {
  const cs = new CompressionStream(encoding);
  const writer = cs.writable.getWriter();
  const encoded = new TextEncoder().encode(body);

  void (async () => {
    try {
      await writer.write(encoded);
      await writer.close();
    } catch {
      // The failure still surfaces to the response consumer via the readable
      // side. Swallowing it here keeps a stream error from becoming an
      // unhandled promise rejection, which is fatal on Node 15+.
    }
  })();

  return cs.readable;
}

/**
 * Response compression plugin using Web Standard CompressionStream.
 * Wraps `reply.json()`, `.send()`, and `.html()` to compress responses above threshold.
 *
 * @example
 * ```ts
 * await app.register(compress({ threshold: 1024 }));
 * ```
 */
export function compress(options: CompressOptions = {}): PluginFunction {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const encodings = options.encodings ?? DEFAULT_ENCODINGS;
  const filter = options.filter ?? ((_req, _reply, contentType) => isCompressibleContentType(contentType));

  return function compressPlugin(app) {
    const hook: HookHandler = (request: CelsianRequest, reply: CelsianReply) => {
      const encoding = negotiateEncoding(request.headers.get("accept-encoding") ?? "", encodings);

      const originalJson = reply.json.bind(reply);
      const originalSend = reply.send.bind(reply);
      const originalHtml = reply.html.bind(reply);

      /**
       * `Vary: Accept-Encoding` must be present on EVERY response this plugin
       * could have compressed, not only the compressed ones. Without it a CDN
       * is free to serve a stored uncompressed body to a gzip client and vice
       * versa. Applied immediately before the response is built (rather than in
       * the hook body) so a handler that sets its own `Vary` cannot clobber it,
       * and applied via the reply so it stays in the core fast-response payload.
       */
      const markVary = (): void => {
        reply.header("vary", withVaryAcceptEncoding(reply.headers.vary));
      };

      /**
       * Build the real Response via the ORIGINAL reply method, then wrap it.
       * Deriving headers from `reply.headers` instead would silently drop every
       * `Set-Cookie`: cookies live on a private array inside the reply and are
       * only materialized by the reply's own response builder.
       */
      const wrap = (build: () => Response, body: string, fallbackContentType: string): Response => {
        markVary();
        if (!encoding) return build();

        // Measure BYTES once. `body.length` counts UTF-16 code units, so the
        // effective threshold would swing 3-4x with the response's language.
        const byteLength = new TextEncoder().encode(body).byteLength;
        const contentType = reply.headers["content-type"] ?? fallbackContentType;

        if (byteLength < threshold) return build();
        if (!filter(request, reply, contentType)) return build();

        const response = build();
        // Never double-encode a body the handler already compressed.
        if (response.headers.has("content-encoding")) return response;

        const headers = copyHeadersPreservingCookies(response.headers);
        headers.set("content-encoding", encoding);
        headers.delete("content-length");
        // Do NOT overwrite an explicitly set content-type — an image/png must
        // not become text/plain just because it went through reply.send().
        if (!headers.has("content-type")) headers.set("content-type", contentType);

        return new Response(compressStream(body, encoding), { status: response.status, headers });
      };

      reply.json = (data: unknown): Response =>
        wrap(() => originalJson(data), JSON.stringify(data), "application/json; charset=utf-8");

      reply.send = (data: unknown): Response => {
        if (data instanceof Response) return data;
        if (data === null || data === undefined || data instanceof Uint8Array || data instanceof ArrayBuffer) {
          markVary();
          return originalSend(data);
        }
        const body = typeof data === "string" ? data : JSON.stringify(data);
        const fallback = typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
        return wrap(() => originalSend(data), body, fallback);
      };

      reply.html = (content: string): Response =>
        wrap(() => originalHtml(content), content, "text/html; charset=utf-8");
    };

    app.addHook("onRequest", hook as HookHandler);
  };
}
