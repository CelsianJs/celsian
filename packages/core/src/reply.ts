// @celsian/core — CelsianReply implementation

import { type CookieOptions, serializeCookie } from "./cookie.js";
import { HttpError } from "./errors.js";
import { fastResponse } from "./fast-response.js";
import type { CelsianReply } from "./types.js";

/** Options accepted by `reply.sendFile()`. */
export interface SendFileOptions {
  /**
   * Directory the served file must stay inside. Defaults to the process CWD.
   * The contract is mandatory: a resolved path outside `root` is always a 403,
   * there is no "unconfined" mode.
   */
  root?: string;
  /**
   * Follow symlinks that point outside `root` (default: false). With the
   * default, both the root and the target are resolved with `realpath()` and
   * the containment check is re-applied to the real paths, so a symlink planted
   * inside the served directory (uploads, extracted archives) cannot escape.
   */
  allowSymlinks?: boolean;
}

/** Options accepted by `reply.download()`. */
export interface DownloadOptions extends SendFileOptions {
  /** Filename advertised in Content-Disposition (defaults to the file's basename). */
  filename?: string;
}

/** Options accepted by `reply.redirect()`. */
export interface RedirectOptions {
  /**
   * Hosts an absolute redirect may target (e.g. `['checkout.example.com']`).
   * Absolute URLs to any other host are rejected with a 400 so a
   * user-controlled `?next=` value cannot become an open redirect.
   */
  allowedHosts?: string[];
}

// Extra overloads for the reply methods hardened in 0.6.0. These belong in
// types.ts (owned elsewhere); declared here so the options are typed for users.
declare module "./types.js" {
  interface CelsianReply {
    sendFile(filePath: string, options?: SendFileOptions): Promise<Response>;
    download(filePath: string, options?: DownloadOptions): Promise<Response>;
    download(filePath: string, filename?: string): Promise<Response>;
    redirect(url: string, code?: number, options?: RedirectOptions): Response;
  }
}

/** Current working directory, or "/" on runtimes without a process CWD. */
function currentDir(): string {
  return typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : "/";
}

type ConfinedPath = { ok: true; path: string } | { ok: false; status: 403 | 404 };

/**
 * Resolve `filePath` inside `root` (default: CWD) and verify it does not escape,
 * both lexically and, unless `allowSymlinks` is set, after `realpath()`.
 * Returns 403 for an escape and 404 when the path does not exist.
 */
async function resolveConfinedPath(filePath: string, options: SendFileOptions | undefined): Promise<ConfinedPath> {
  const { resolve, sep } = await import("node:path");
  const { realpath } = await import("node:fs/promises");

  const isInside = (target: string, root: string): boolean => target === root || target.startsWith(root + sep);

  const resolvedRoot = resolve(options?.root ?? currentDir());
  // `resolve` normalizes ".." segments but constrains nothing on its own, and an
  // absolute filePath replaces root entirely — the containment check below is
  // what actually enforces confinement.
  const resolvedPath = resolve(resolvedRoot, filePath);
  if (!isInside(resolvedPath, resolvedRoot)) {
    return { ok: false, status: 403 };
  }

  if (options?.allowSymlinks) {
    return { ok: true, path: resolvedPath };
  }

  let realRoot: string;
  let realPath: string;
  try {
    realRoot = await realpath(resolvedRoot);
    realPath = await realpath(resolvedPath);
  } catch {
    // ENOENT (and friends) means there is nothing to serve, not a server fault.
    return { ok: false, status: 404 };
  }
  if (!isInside(realPath, realRoot)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, path: realPath };
}

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

/** JSON error body for a file that is missing (404) or outside the root (403). */
function fileErrorResponse(status: 403 | 404, buildHeaders: (extra?: Record<string, string>) => Headers): Response {
  const error = status === 403 ? "Forbidden" : "Not Found";
  const code = status === 403 ? "FORBIDDEN" : "NOT_FOUND";
  return new Response(JSON.stringify({ error, statusCode: status, code }), {
    status,
    headers: buildHeaders({ "content-type": "application/json; charset=utf-8" }),
  });
}

/**
 * Validate a redirect target and return the Location value to emit.
 *
 * Relative paths are allowed. Protocol-relative targets are rejected, including
 * the backslash variants (`/\evil.com`, `\\evil.com`) that browsers normalize
 * into `//evil.com`. Absolute http(s) URLs are rejected unless their host is in
 * `allowedHosts`. Everything else (javascript:, data:, garbage) is a 400, never
 * an uncaught 500.
 */
function safeRedirectLocation(url: string, allowedHosts?: string[]): string {
  // Browsers treat "\" as "/" in the authority position, so normalize before
  // every check rather than after.
  const normalized = url.replace(/\\/g, "/");

  if (normalized.startsWith("/")) {
    if (normalized.startsWith("//")) {
      throw new HttpError(400, `Invalid redirect URL: "${url}". Protocol-relative redirects are not allowed.`, {
        code: "INVALID_REDIRECT",
      });
    }
    return normalized;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new HttpError(400, `Invalid redirect URL: "${url}". Must start with "/", "http://", or "https://".`, {
      code: "INVALID_REDIRECT",
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, `Invalid redirect URL: "${url}". Must start with "/", "http://", or "https://".`, {
      code: "INVALID_REDIRECT",
    });
  }

  const hosts = allowedHosts ?? [];
  if (!hosts.includes(parsed.host) && !hosts.includes(parsed.hostname)) {
    throw new HttpError(
      400,
      `Refusing to redirect to external host "${parsed.host}". ` +
        `Pass { allowedHosts: ["${parsed.host}"] } to reply.redirect() to allow it.`,
      { code: "INVALID_REDIRECT" },
    );
  }

  return parsed.toString();
}

/**
 * Create a new reply builder. Provides chainable methods for setting status, headers,
 * cookies, and sending JSON/HTML/stream/file responses plus structured error helpers.
 */
export function createReply(): CelsianReply {
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
      // No-body status codes (204, 304) or empty data — no content-type added
      if (statusCode === 204 || statusCode === 304 || data === null || data === undefined) {
        return fastResponse(null, statusCode, { ...headers }, setCookies);
      }
      if (typeof data === "string") {
        return fastResponse(data, statusCode, { "content-type": "text/plain; charset=utf-8", ...headers }, setCookies);
      }
      // Binary payloads (Uint8Array covers Node Buffer) — send raw bytes, never
      // JSON.stringify (which would produce {"0":137,...}). Default content-type
      // is application/octet-stream; an explicitly set content-type header wins.
      if (data instanceof Uint8Array) {
        return fastResponse(data, statusCode, { "content-type": "application/octet-stream", ...headers }, setCookies);
      }
      if (data instanceof ArrayBuffer) {
        return fastResponse(
          new Uint8Array(data),
          statusCode,
          { "content-type": "application/octet-stream", ...headers },
          setCookies,
        );
      }
      return fastResponse(
        JSON.stringify(data),
        statusCode,
        { "content-type": "application/json; charset=utf-8", ...headers },
        setCookies,
      );
    },

    html(content: string): Response {
      sent = true;
      return fastResponse(content, statusCode, { "content-type": "text/html; charset=utf-8", ...headers }, setCookies);
    },

    json(data: unknown): Response {
      sent = true;
      return fastResponse(
        JSON.stringify(data),
        statusCode,
        { "content-type": "application/json; charset=utf-8", ...headers },
        setCookies,
      );
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

    redirect(url: string, code = 302, options?: RedirectOptions): Response {
      const location = safeRedirectLocation(url, options?.allowedHosts);
      sent = true;
      return new Response(null, {
        status: code,
        headers: buildHeaders({ location, ...headers }),
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
      try {
        // Lazy import — keeps reply.ts edge-compatible when sendFile isn't used
        const { readFile, stat } = await import("node:fs/promises");
        const { extname } = await import("node:path");

        const resolved = await resolveConfinedPath(filePath, options);
        if (!resolved.ok) return fileErrorResponse(resolved.status, buildHeaders);

        await stat(resolved.path);
        const data = await readFile(resolved.path);
        const ext = extname(resolved.path).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        return new Response(data, {
          status: statusCode,
          headers: buildHeaders({ "content-type": contentType, ...headers }),
        });
      } catch {
        return fileErrorResponse(404, buildHeaders);
      }
    },

    async download(filePath: string, filenameOrOptions?: string | DownloadOptions): Promise<Response> {
      sent = true;
      try {
        // Lazy import — keeps reply.ts edge-compatible when download isn't used
        const { readFile, stat } = await import("node:fs/promises");
        const { extname, basename } = await import("node:path");

        const opts: DownloadOptions =
          typeof filenameOrOptions === "string" ? { filename: filenameOrOptions } : (filenameOrOptions ?? {});

        // Confined exactly like sendFile: without a root, downloads are limited
        // to the process CWD. Serving outside it requires an explicit root.
        const resolved = await resolveConfinedPath(filePath, opts);
        if (!resolved.ok) return fileErrorResponse(resolved.status, buildHeaders);

        await stat(resolved.path);
        const data = await readFile(resolved.path);
        const ext = extname(resolved.path).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        const downloadName = opts.filename ?? basename(resolved.path);
        // Sanitize filename to prevent header injection via Content-Disposition
        const safeName = downloadName.replace(/["\r\n]/g, "");
        return new Response(data, {
          status: statusCode,
          headers: buildHeaders({
            "content-type": contentType,
            "content-disposition": `attachment; filename="${safeName}"`,
            ...headers,
          }),
        });
      } catch {
        return fileErrorResponse(404, buildHeaders);
      }
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
