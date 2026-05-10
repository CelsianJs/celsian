// @celsian/core — CelsianReply implementation

import { type CookieOptions, serializeCookie } from "./cookie.js";
import type { CelsianReply, SendFileOptions } from "./types.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

/** Default threshold (in bytes) above which a warning is logged. 50MB. */
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024;

/** A pre-compiled serializer function that replaces JSON.stringify for known schemas. */
export type FastSerializer = (data: unknown) => string;

/**
 * Create a new reply builder. Provides chainable methods for setting status, headers,
 * cookies, and sending JSON/HTML/stream/file responses plus structured error helpers.
 *
 * When a `serializer` is provided (pre-compiled from route's schema.response),
 * `json()` and `send()` use it instead of generic JSON.stringify for ~15-20% throughput gain.
 */
export function createReply(serializer?: FastSerializer | null): CelsianReply {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  let sent = false;

  const reply: CelsianReply = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(code: number) {
      statusCode = code;
    },

    get headers() {
      return headers;
    },

    get sent() {
      return sent;
    },
    set sent(value: boolean) {
      sent = value;
    },

    status(code: number) {
      statusCode = code;
      return reply;
    },

    header(key: string, value: string) {
      // Prevent CRLF header injection by stripping \r and \n
      headers[key.toLowerCase()] = value.replace(/[\r\n]/g, "");
      return reply;
    },

    send(data: unknown): Response {
      sent = true;
      if (data instanceof Response) {
        return data;
      }
      // No-body status codes (204, 304) — ignore data
      if (statusCode === 204 || statusCode === 304) {
        return new Response(null, {
          status: statusCode,
          headers: setCookies.length === 0 ? headers : buildHeaders(headers),
        });
      }
      if (data === null || data === undefined) {
        return new Response(null, {
          status: statusCode,
          headers: setCookies.length === 0 ? headers : buildHeaders(headers),
        });
      }
      if (typeof data === "string") {
        const h = { "content-type": "text/plain; charset=utf-8", ...headers };
        return new Response(data, {
          status: statusCode,
          headers: setCookies.length === 0 ? h : buildHeaders(h),
        });
      }
      const h = { "content-type": "application/json; charset=utf-8", ...headers };
      return new Response(serializer ? serializer(data) : JSON.stringify(data), {
        status: statusCode,
        headers: setCookies.length === 0 ? h : buildHeaders(h),
      });
    },

    html(content: string): Response {
      sent = true;
      const h = { "content-type": "text/html; charset=utf-8", ...headers };
      return new Response(content, {
        status: statusCode,
        headers: setCookies.length === 0 ? h : buildHeaders(h),
      });
    },

    json(data: unknown): Response {
      sent = true;
      // Use pre-compiled serializer when available (from schema.response)
      const body = serializer ? serializer(data) : JSON.stringify(data);
      // Fast path: no cookies set — use plain object headers (avoids new Headers())
      if (setCookies.length === 0) {
        return new Response(body, {
          status: statusCode,
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...headers,
          },
        });
      }
      return new Response(body, {
        status: statusCode,
        headers: buildHeaders({
          "content-type": "application/json; charset=utf-8",
          ...headers,
        }),
      });
    },

    stream(readable: ReadableStream): Response {
      sent = true;
      return new Response(readable, {
        status: statusCode,
        headers: buildHeaders({
          "content-type": "application/octet-stream",
          ...headers,
        }),
      });
    },

    redirect(url: string, code = 302): Response {
      sent = true;
      return new Response(null, {
        status: code,
        headers: buildHeaders({ location: url, ...headers }),
      });
    },

    cookie(name: string, value: string, options?: CookieOptions) {
      setCookies.push(serializeCookie(name, value, options));
      return reply;
    },

    clearCookie(name: string, options?: CookieOptions) {
      setCookies.push(serializeCookie(name, "", { ...options, maxAge: 0 }));
      return reply;
    },

    async sendFile(filePath: string, options?: SendFileOptions): Promise<Response> {
      sent = true;
      return serveFile(filePath, statusCode, headers, buildHeaders, options);
    },

    async download(filePath: string, filename?: string, options?: SendFileOptions): Promise<Response> {
      sent = true;
      const { basename } = await import("node:path");
      const downloadFilename = filename ?? basename(filePath);
      const safeName = downloadFilename.replace(/["\r\n]/g, "");
      const extraHeaders: Record<string, string> = {
        "content-disposition": `attachment; filename="${safeName}"`,
      };
      return serveFile(filePath, statusCode, { ...extraHeaders, ...headers }, buildHeaders, options);
    },

    // ─── Status Code Helpers ───

    notFound(message = "Not Found") {
      return errorResponse(reply, 404, "NOT_FOUND", message);
    },
    badRequest(message = "Bad Request") {
      return errorResponse(reply, 400, "BAD_REQUEST", message);
    },
    unauthorized(message = "Unauthorized") {
      return errorResponse(reply, 401, "UNAUTHORIZED", message);
    },
    forbidden(message = "Forbidden") {
      return errorResponse(reply, 403, "FORBIDDEN", message);
    },
    conflict(message = "Conflict") {
      return errorResponse(reply, 409, "CONFLICT", message);
    },
    gone(message = "Gone") {
      return errorResponse(reply, 410, "GONE", message);
    },
    tooManyRequests(message = "Too Many Requests") {
      return errorResponse(reply, 429, "TOO_MANY_REQUESTS", message);
    },
    internalServerError(message?: string) {
      return errorResponse(reply, 500, "INTERNAL_SERVER_ERROR", message ?? "Internal Server Error", true);
    },
    serviceUnavailable(message?: string) {
      return errorResponse(reply, 503, "SERVICE_UNAVAILABLE", message ?? "Service Unavailable", true);
    },
  };

  function errorResponse(
    r: CelsianReply,
    status: number,
    code: string,
    message: string,
    sanitizeInProd = false,
  ): Response {
    const safeMessage =
      sanitizeInProd && process.env.NODE_ENV === "production"
        ? status === 500
          ? "Internal Server Error"
          : "Service Unavailable"
        : message;
    return r.status(status).json({ error: safeMessage, statusCode: status, code });
  }

  function buildHeaders(extra: Record<string, string> = {}): Headers {
    const h = new Headers(extra);
    for (const cookie of setCookies) {
      h.append("set-cookie", cookie);
    }
    return h;
  }

  return reply;
}

// ─── Shared File Serving Logic ───

/**
 * Shared implementation for sendFile() and download(). Handles:
 * - Path resolution and traversal protection
 * - Stat-based ETag generation (no full file read)
 * - Conditional GET (If-None-Match, If-Modified-Since) -> 304
 * - Streaming via createReadStream with byte-range seek
 * - Range requests (single and multi-range)
 * - Large file size warning
 */
async function serveFile(
  filePath: string,
  statusCode: number,
  replyHeaders: Record<string, string>,
  buildHeaders: (extra?: Record<string, string>) => Headers,
  options?: SendFileOptions,
): Promise<Response> {
  try {
    const { createReadStream, constants: fsConstants } = await import("node:fs");
    const { stat: fsStat, access } = await import("node:fs/promises");
    const { extname, resolve } = await import("node:path");
    const { Readable } = await import("node:stream");

    // ─── Path resolution & traversal protection ───
    let resolvedPath: string;
    if (options?.root) {
      const resolvedRoot = resolve(options.root);
      resolvedPath = resolve(resolvedRoot, filePath);
      if (!resolvedPath.startsWith(resolvedRoot)) {
        return new Response(JSON.stringify({ error: "Forbidden", statusCode: 403, code: "PATH_TRAVERSAL" }), {
          status: 403,
          headers: buildHeaders({ "content-type": "application/json; charset=utf-8" }),
        });
      }
    } else {
      resolvedPath = resolve(filePath);
    }

    const fileStat = await fsStat(resolvedPath);
    // Verify read access before streaming (stat succeeds on 0o000 files but read would fail)
    await access(resolvedPath, fsConstants.R_OK);
    const totalSize = fileStat.size;
    const ext = extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    // Generate ETag from inode + size + mtime (no file read required)
    const etag = `"${fileStat.ino.toString(36)}-${totalSize.toString(36)}-${fileStat.mtimeMs.toString(36)}"`;
    const lastModified = fileStat.mtime.toUTCString();

    // Large file warning
    const threshold = options?.largeFileThreshold ?? LARGE_FILE_THRESHOLD;
    if (threshold > 0 && totalSize > threshold) {
      console.warn(
        `[celsian] Serving large file (${(totalSize / 1024 / 1024).toFixed(1)}MB): ${resolvedPath}`,
      );
    }

    // ─── Conditional GET: 304 Not Modified ───
    if (options?.request) {
      const ifNoneMatch = options.request.headers.get("if-none-match");
      if (ifNoneMatch) {
        // Support both exact match and weak comparison (W/"...")
        const tags = ifNoneMatch.split(",").map((t) => t.trim().replace(/^W\//, ""));
        if (tags.includes(etag) || ifNoneMatch === "*") {
          return new Response(null, {
            status: 304,
            headers: buildHeaders({ etag, "last-modified": lastModified, ...replyHeaders }),
          });
        }
      }

      const ifModifiedSince = options.request.headers.get("if-modified-since");
      if (ifModifiedSince && !options.request.headers.get("if-none-match")) {
        const ifModifiedDate = new Date(ifModifiedSince);
        // Compare at second precision (HTTP dates are second-granularity)
        if (!isNaN(ifModifiedDate.getTime()) && fileStat.mtime.getTime() <= ifModifiedDate.getTime() + 999) {
          return new Response(null, {
            status: 304,
            headers: buildHeaders({ etag, "last-modified": lastModified, ...replyHeaders }),
          });
        }
      }
    }

    const baseHeaders: Record<string, string> = {
      "content-type": contentType,
      etag,
      "last-modified": lastModified,
      "accept-ranges": "bytes",
      ...replyHeaders,
    };

    // Apply Cache-Control header if specified
    if (options?.cacheControl !== undefined && options.cacheControl !== false) {
      baseHeaders["cache-control"] = options.cacheControl;
    }

    // ─── Range request handling ───
    const rangeHeader = options?.request?.headers.get("range");
    if (rangeHeader && options?.request) {
      // Check If-Range: only serve partial if ETag or Last-Modified matches
      const ifRange = options.request.headers.get("if-range");
      if (ifRange) {
        const ifRangeValid = ifRange === etag || ifRange === lastModified;
        if (!ifRangeValid) {
          // If-Range doesn't match — serve full response via stream
          const stream = createReadStream(resolvedPath);
          const webStream = Readable.toWeb(stream) as ReadableStream;
          return new Response(webStream, {
            status: statusCode,
            headers: buildHeaders({
              ...baseHeaders,
              "content-length": totalSize.toString(),
            }),
          });
        }
      }

      const ranges = parseRangeHeader(rangeHeader, totalSize);
      if (ranges === null) {
        return new Response(
          JSON.stringify({ error: "Range Not Satisfiable", statusCode: 416, code: "RANGE_NOT_SATISFIABLE" }),
          {
            status: 416,
            headers: buildHeaders({
              "content-type": "application/json; charset=utf-8",
              "content-range": `bytes */${totalSize}`,
            }),
          },
        );
      }

      if (ranges.length === 1) {
        // Single range — stream with byte-range seek
        const [start, end] = ranges[0]!;
        const stream = createReadStream(resolvedPath, { start, end });
        const webStream = Readable.toWeb(stream) as ReadableStream;
        return new Response(webStream, {
          status: 206,
          headers: buildHeaders({
            ...baseHeaders,
            "content-length": (end - start + 1).toString(),
            "content-range": `bytes ${start}-${end}/${totalSize}`,
          }),
        });
      }

      // Multi-range — must buffer parts for multipart response
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(resolvedPath);
      const boundary = "celsian_range_" + Date.now().toString(36);
      const parts: Uint8Array[] = [];
      const encoder = new TextEncoder();

      for (const [start, end] of ranges) {
        const partHeader = `\r\n--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Range: bytes ${start}-${end}/${totalSize}\r\n\r\n`;
        parts.push(encoder.encode(partHeader));
        parts.push(data.slice(start, end + 1));
      }
      parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

      const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
      const multipartBody = new Uint8Array(totalLength);
      let offset = 0;
      for (const part of parts) {
        multipartBody.set(part, offset);
        offset += part.byteLength;
      }

      return new Response(multipartBody, {
        status: 206,
        headers: buildHeaders({
          "content-type": `multipart/byteranges; boundary=${boundary}`,
          "content-length": totalLength.toString(),
          etag,
          "last-modified": lastModified,
          "accept-ranges": "bytes",
          ...replyHeaders,
        }),
      });
    }

    // ─── Full response via stream ───
    const stream = createReadStream(resolvedPath);
    const webStream = Readable.toWeb(stream) as ReadableStream;
    return new Response(webStream, {
      status: statusCode,
      headers: buildHeaders({
        ...baseHeaders,
        "content-length": totalSize.toString(),
      }),
    });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return new Response(JSON.stringify({ error: "Not Found", statusCode: 404, code: "NOT_FOUND" }), {
        status: 404,
        headers: buildHeaders({ "content-type": "application/json; charset=utf-8" }),
      });
    }
    if (code === "EACCES" || code === "EPERM") {
      return new Response(JSON.stringify({ error: "Forbidden", statusCode: 403, code: "FORBIDDEN" }), {
        status: 403,
        headers: buildHeaders({ "content-type": "application/json; charset=utf-8" }),
      });
    }
    // Unexpected error — log and return 500
    console.error("[celsian] sendFile error:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error", statusCode: 500, code: "INTERNAL_SERVER_ERROR" }), {
      status: 500,
      headers: buildHeaders({ "content-type": "application/json; charset=utf-8" }),
    });
  }
}

/**
 * Parse an HTTP Range header into an array of [start, end] tuples (inclusive).
 * Returns null if the range is invalid or unsatisfiable.
 *
 * Supports:
 * - `bytes=0-499` (start-end)
 * - `bytes=500-` (start to end-of-file)
 * - `bytes=-500` (last 500 bytes)
 * - `bytes=0-499, 1000-1499` (multi-range)
 */
function parseRangeHeader(rangeHeader: string, totalSize: number): [number, number][] | null {
  if (!rangeHeader.startsWith("bytes=")) return null;

  const rangeSpec = rangeHeader.slice(6);
  const parts = rangeSpec.split(",").map((s) => s.trim());
  const ranges: [number, number][] = [];

  for (const part of parts) {
    if (part.startsWith("-")) {
      // Suffix range: `-500` means last 500 bytes
      const suffix = parseInt(part.slice(1), 10);
      if (isNaN(suffix) || suffix <= 0) return null;
      const start = Math.max(0, totalSize - suffix);
      ranges.push([start, totalSize - 1]);
    } else {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr!, 10);
      if (isNaN(start)) return null;

      let end: number;
      if (!endStr || endStr === "") {
        // Open-ended range: `500-` means 500 to end
        end = totalSize - 1;
      } else {
        end = parseInt(endStr, 10);
        if (isNaN(end)) return null;
      }

      // Clamp end to file size
      if (end >= totalSize) end = totalSize - 1;

      // Validate range
      if (start > end || start >= totalSize) return null;

      ranges.push([start, end]);
    }
  }

  if (ranges.length === 0) return null;
  return ranges;
}
