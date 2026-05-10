// @celsian/compress — Response compression plugin with Brotli, Gzip, and Deflate

import type { CelsianReply, CelsianRequest, HookHandler, PluginFunction } from "@celsian/core";

export type CompressionEncoding = "br" | "gzip" | "deflate";

/** Options for the compression plugin: byte threshold, allowed encodings, and quality. */
export interface CompressOptions {
  /** Minimum response size in bytes to trigger compression (default: 1024) */
  threshold?: number;
  /** Allowed compression encodings in preference order (default: ["br", "gzip", "deflate"]) */
  encodings?: CompressionEncoding[];
  /** Brotli quality level 0-11 (default: 4 — good balance of speed and ratio) */
  brotliQuality?: number;
}

const DEFAULT_THRESHOLD = 1024;
const DEFAULT_ENCODINGS: CompressionEncoding[] = ["br", "gzip", "deflate"];
const DEFAULT_BROTLI_QUALITY = 4;
/**
 * Negotiate the best compression encoding from Accept-Encoding header.
 * Returns the first supported encoding found in the accept list,
 * respecting the server's preference order (Brotli > gzip > deflate by default).
 *
 * Handles quality values (q=0 means explicitly rejected).
 */
function negotiateEncoding(acceptEncoding: string, supported: CompressionEncoding[]): CompressionEncoding | null {
  const accepted = acceptEncoding.toLowerCase();

  // Parse quality values to respect q=0 (rejected)
  const rejected = new Set<string>();
  const parts = accepted.split(",").map((s) => s.trim());
  for (const part of parts) {
    const [encoding, ...params] = part.split(";").map((s) => s.trim());
    if (!encoding) continue;
    for (const param of params) {
      if (param.startsWith("q=")) {
        const q = parseFloat(param.slice(2));
        if (q === 0) rejected.add(encoding);
      }
    }
  }

  for (const encoding of supported) {
    if (rejected.has(encoding)) continue;
    if (accepted.includes(encoding)) {
      return encoding;
    }
  }
  return null;
}

/**
 * Compress body using CompressionStream (gzip/deflate) — Web Standard API.
 */
function compressBody(
  body: string,
  encoding: "gzip" | "deflate",
  contentType: string,
  statusCode: number,
  extraHeaders: Headers,
): Response {
  const cs = new CompressionStream(encoding);
  const writer = cs.writable.getWriter();
  const encoded = new TextEncoder().encode(body);
  writer.write(encoded);
  writer.close();

  extraHeaders.set("content-encoding", encoding);
  extraHeaders.set("content-type", contentType);
  extraHeaders.delete("content-length");
  extraHeaders.append("vary", "accept-encoding");

  return new Response(cs.readable, {
    status: statusCode,
    headers: extraHeaders,
  });
}

/**
 * Response compression plugin supporting Brotli, Gzip, and Deflate.
 * Wraps `reply.json()`, `.send()`, and `.html()` to compress responses above threshold.
 *
 * **Limitation**: `reply.stream()` is NOT compressed. Streams are typically
 * binary/chunked data where the caller controls encoding, so automatic
 * compression is intentionally skipped. If you need compressed streaming,
 * pipe through a `CompressionStream` before passing to `reply.stream()`.
 *
 * Brotli is preferred over gzip when both are accepted, as it provides
 * ~15-25% better compression ratios for text content.
 *
 * @example
 * ```ts
 * // Default: Brotli + Gzip + Deflate
 * await app.register(compress());
 *
 * // Custom quality and threshold
 * await app.register(compress({
 *   threshold: 512,
 *   brotliQuality: 6,
 * }));
 *
 * // Gzip only (disable Brotli)
 * await app.register(compress({
 *   encodings: ['gzip', 'deflate'],
 * }));
 * ```
 */
export function compress(options: CompressOptions = {}): PluginFunction {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const encodings = options.encodings ?? DEFAULT_ENCODINGS;
  const brotliQuality = options.brotliQuality ?? DEFAULT_BROTLI_QUALITY;

  return function compressPlugin(app) {
    const hook: HookHandler = (request: CelsianRequest, reply: CelsianReply) => {
      const acceptEncoding = request.headers.get("accept-encoding") ?? "";
      const encoding = negotiateEncoding(acceptEncoding, encodings);

      if (!encoding) return;

      // Wrap reply methods to compress output above threshold
      const originalJson = reply.json.bind(reply);
      const originalSend = reply.send.bind(reply);
      const originalHtml = reply.html.bind(reply);

      if (encoding === "br") {
        // Brotli path — async compression via node:zlib
        reply.json = (data: unknown): Response => {
          const body = JSON.stringify(data);
          if (body.length < threshold) return originalJson(data);
          reply.sent = true;
          const responseHeaders = new Headers(reply.headers);
          // Return a Response that wraps the async Brotli compression
          // We need to return a Response synchronously, so we use a ReadableStream
          const stream = new ReadableStream({
            async start(controller) {
              try {
                const { brotliCompress, constants } = await import("node:zlib");
                const { promisify } = await import("node:util");
                const compress = promisify(brotliCompress);
                const compressed = await compress(Buffer.from(body, "utf-8"), {
                  params: { [constants.BROTLI_PARAM_QUALITY]: brotliQuality },
                });
                controller.enqueue(compressed);
                controller.close();
              } catch (err) {
                controller.error(err);
              }
            },
          });

          responseHeaders.set("content-encoding", "br");
          responseHeaders.set("content-type", "application/json; charset=utf-8");
          responseHeaders.delete("content-length");
          responseHeaders.append("vary", "accept-encoding");

          return new Response(stream, {
            status: reply.statusCode,
            headers: responseHeaders,
          });
        };

        reply.send = (data: unknown): Response => {
          if (data instanceof Response) return data;
          const body = typeof data === "string" ? data : JSON.stringify(data);
          if (body.length < threshold) return originalSend(data);
          reply.sent = true;
          const ct = typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
          const responseHeaders = new Headers(reply.headers);

          const stream = new ReadableStream({
            async start(controller) {
              try {
                const { brotliCompress, constants } = await import("node:zlib");
                const { promisify } = await import("node:util");
                const compress = promisify(brotliCompress);
                const compressed = await compress(Buffer.from(body, "utf-8"), {
                  params: { [constants.BROTLI_PARAM_QUALITY]: brotliQuality },
                });
                controller.enqueue(compressed);
                controller.close();
              } catch (err) {
                controller.error(err);
              }
            },
          });

          responseHeaders.set("content-encoding", "br");
          responseHeaders.set("content-type", ct);
          responseHeaders.delete("content-length");
          responseHeaders.append("vary", "accept-encoding");

          return new Response(stream, {
            status: reply.statusCode,
            headers: responseHeaders,
          });
        };

        reply.html = (content: string): Response => {
          if (content.length < threshold) return originalHtml(content);
          reply.sent = true;
          const responseHeaders = new Headers(reply.headers);

          const stream = new ReadableStream({
            async start(controller) {
              try {
                const { brotliCompress, constants } = await import("node:zlib");
                const { promisify } = await import("node:util");
                const compress = promisify(brotliCompress);
                const compressed = await compress(Buffer.from(content, "utf-8"), {
                  params: { [constants.BROTLI_PARAM_QUALITY]: brotliQuality },
                });
                controller.enqueue(compressed);
                controller.close();
              } catch (err) {
                controller.error(err);
              }
            },
          });

          responseHeaders.set("content-encoding", "br");
          responseHeaders.set("content-type", "text/html; charset=utf-8");
          responseHeaders.delete("content-length");
          responseHeaders.append("vary", "accept-encoding");

          return new Response(stream, {
            status: reply.statusCode,
            headers: responseHeaders,
          });
        };
      } else {
        // Gzip / Deflate path — CompressionStream API
        reply.json = (data: unknown): Response => {
          const body = JSON.stringify(data);
          if (body.length < threshold) return originalJson(data);
          reply.sent = true;
          const responseHeaders = new Headers(reply.headers);
          return compressBody(body, encoding, "application/json; charset=utf-8", reply.statusCode, responseHeaders);
        };

        reply.send = (data: unknown): Response => {
          if (data instanceof Response) return data;
          const body = typeof data === "string" ? data : JSON.stringify(data);
          if (body.length < threshold) return originalSend(data);
          reply.sent = true;
          const ct = typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
          const responseHeaders = new Headers(reply.headers);
          return compressBody(body, encoding, ct, reply.statusCode, responseHeaders);
        };

        reply.html = (content: string): Response => {
          if (content.length < threshold) return originalHtml(content);
          reply.sent = true;
          const responseHeaders = new Headers(reply.headers);
          return compressBody(content, encoding, "text/html; charset=utf-8", reply.statusCode, responseHeaders);
        };
      }
    };

    app.addHook("onRequest", hook as HookHandler);
  };
}
