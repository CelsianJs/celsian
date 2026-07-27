// @celsian/core, CelsianReply implementation

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
   * default, both the root and the target are resolved with `realpath()`, the
   * containment check is re-applied to the real paths, and the file is then
   * opened once with `O_NOFOLLOW`, so a symlink planted inside the served
   * directory (uploads, extracted archives) cannot escape, and cannot be
   * planted after the check either.
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
export async function resolveConfinedPath(
  filePath: string,
  options: SendFileOptions | undefined,
): Promise<ConfinedPath> {
  const { resolve, sep } = await import("node:path");
  const { realpath } = await import("node:fs/promises");

  const isInside = (target: string, root: string): boolean => target === root || target.startsWith(root + sep);

  const resolvedRoot = resolve(options?.root ?? currentDir());
  // `resolve` normalizes ".." segments but constrains nothing on its own, and an
  // absolute filePath replaces root entirely, the containment check below is
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

/** Result of reading a confined file: the bytes plus the path they came from. */
export type ConfinedRead = { ok: true; data: Uint8Array; path: string } | { ok: false; status: 403 | 404 };

/** Errno of a Node fs rejection, when it carries one. */
function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Resolve `filePath` inside its root and read it through a SINGLE open handle.
 *
 * Returning a path string from the containment check and then re-opening it by
 * name is a TOCTOU race: an attacker who can write inside the served root
 * (uploads, extracted archives, exactly what `allowSymlinks: false` defends
 * against) swaps the leaf for a symlink in the window between `realpath()` and
 * the read, and the read follows it out of the root. `O_NOFOLLOW` makes the
 * kernel refuse a symlinked final component, so the check and the read can no
 * longer disagree, and the handle is read directly rather than looked up twice.
 */
export async function readConfinedFile(filePath: string, options: SendFileOptions | undefined): Promise<ConfinedRead> {
  const resolved = await resolveConfinedPath(filePath, options);
  if (!resolved.ok) return resolved;

  const { open } = await import("node:fs/promises");
  const { constants } = await import("node:fs");

  // With allowSymlinks the caller has opted into following links, so O_NOFOLLOW
  // would break the documented behaviour and is left off.
  const flags = options?.allowSymlinks ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(resolved.path, flags);
  } catch (err) {
    const code = errnoOf(err);
    // ELOOP (EMLINK on some BSDs) is O_NOFOLLOW refusing a symlinked leaf: the
    // path was swapped after the check, treat it as the symlink rejection it is.
    if (code === "ELOOP" || code === "EMLINK") return { ok: false, status: 403 };
    return { ok: false, status: 404 };
  }

  try {
    return { ok: true, data: await handle.readFile(), path: resolved.path };
  } catch {
    // Directories (EISDIR) and unreadable files are "nothing to serve".
    return { ok: false, status: 404 };
  } finally {
    await handle.close().catch(() => {});
  }
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

/** True if `s` contains a C0 control character or DEL. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/**
 * Reduce a redirect target to the string a browser will actually act on.
 *
 * Two separate rewrites happen inside every URL parser before any structural
 * check gets to run, so both have to happen here first or the checks inspect a
 * string nobody will ever navigate to:
 *
 * - **ASCII tab, LF and CR are DELETED outright** (WHATWG URL, "strip leading
 *   and trailing C0 control or space, and remove all ASCII tab or newline").
 *   `"/\t/evil.com"` therefore parses as `//evil.com`, an open redirect that
 *   sails past a `startsWith("//")` test performed on the raw string.
 * - **Backslashes become forward slashes** in the authority position, which is
 *   how `/\evil.com` becomes `//evil.com`.
 *
 * Applied to a fixed point, because in principle either rewrite could expose a
 * new instance of the other. (It cannot today: deleting tabs never produces a
 * backslash and mapping backslashes never produces a tab. The loop costs one
 * extra comparison and removes the need to re-derive that argument whenever the
 * character set here grows.)
 */
function normalizeRedirectTarget(url: string): string {
  let current = url;
  for (;;) {
    let stripped = "";
    for (let i = 0; i < current.length; i++) {
      const c = current.charCodeAt(i);
      // 0x09 TAB, 0x0a LF, 0x0d CR.
      if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
      stripped += current[i];
    }
    const next = stripped.replace(/\\/g, "/");
    if (next === current) return current;
    current = next;
  }
}

/**
 * Validate a redirect target and return the Location value to emit.
 *
 * Relative paths are allowed. Protocol-relative targets are rejected, including
 * the backslash variants (`/\evil.com`, `\\evil.com`) and the tab/newline
 * variants (`/\t/evil.com`) that URL parsers normalize into `//evil.com`.
 * Absolute http(s) URLs are rejected unless their host is in `allowedHosts`.
 * Everything else (javascript:, data:, garbage) is a 400, never an uncaught 500.
 */
function safeRedirectLocation(url: string, allowedHosts?: string[]): string {
  const normalized = normalizeRedirectTarget(url);

  if (normalized.startsWith("/")) {
    if (normalized.startsWith("//")) {
      throw new HttpError(400, `Invalid redirect URL: "${url}". Protocol-relative redirects are not allowed.`, {
        code: "INVALID_REDIRECT",
      });
    }
    // Tab/CR/LF are gone by now; anything still in the C0 range (NUL above all)
    // would be rejected by `new Headers()` with a TypeError, which the caller
    // has no handler for and which surfaces as a 500 with a stack trace. This
    // function promises a 400, so reject it here instead.
    if (hasControlChar(normalized)) {
      throw new HttpError(400, `Invalid redirect URL: "${url}". Control characters are not allowed.`, {
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
 * Build a `Content-Disposition: attachment` value for `name`.
 *
 * A header value is Latin-1 at best, and `new Response()` throws a TypeError on
 * anything outside it, so a perfectly ordinary filename ("rapport-été.pdf",
 * anything in Japanese) used to blow up response construction. Two parameters
 * are emitted instead:
 *
 * - `filename=` carries a printable-ASCII reduction that every client
 *   understands. Quotes and backslashes are dropped so they cannot terminate
 *   the quoted string, and CR/LF go with them (header injection).
 * - `filename*=` carries the real name, RFC 5987 / RFC 6266 percent-encoded as
 *   UTF-8, and is preferred by every current browser.
 *
 * `filename*` is emitted only when the ASCII reduction actually lost something,
 * so plain names keep the exact single-parameter header they have always had.
 */
function contentDisposition(name: string): string {
  let ascii = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === "\\") continue;
    // Printable ASCII only: control chars inject headers, and anything above
    // 0x7e cannot survive a header value.
    ascii += code >= 0x20 && code <= 0x7e ? ch : "_";
  }
  if (ascii === "") ascii = "download";

  if (ascii === name) return `attachment; filename="${ascii}"`;

  // encodeURIComponent leaves ' ( ) * unescaped, none of which are RFC 5987
  // attr-chars, so they have to be encoded by hand.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Create a new reply builder. Provides chainable methods for setting status, headers,
 * cookies, and sending JSON/HTML/stream/file responses plus structured error helpers.
 *
 * @param requestUrl - The URL of the request being answered. Optional, and only
 * used to pick a `secure` default for `cookie()` / `clearCookie()` that the
 * browser will actually honour. Without it, cookies default to `Secure`, which
 * over plain-HTTP local development means the browser drops them and never
 * sends them back. See `resolveSecureDefault`.
 * @param requestHeaders - The request's headers, read only if a cookie is
 * actually set. They carry `Host` and `x-forwarded-proto`, which describe the
 * origin the browser sees, whereas `requestUrl` often carries the address the
 * server bound to.
 */
export function createReply(requestUrl?: string | URL, requestHeaders?: Headers): CelsianReply {
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
      // No-body status codes (204, 304) or empty data, no content-type added
      if (statusCode === 204 || statusCode === 304 || data === null || data === undefined) {
        return fastResponse(null, statusCode, { ...headers }, setCookies);
      }
      if (typeof data === "string") {
        return fastResponse(data, statusCode, { "content-type": "text/plain; charset=utf-8", ...headers }, setCookies);
      }
      // Binary payloads (Uint8Array covers Node Buffer), send raw bytes, never
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
      setCookies.push(serializeCookie(name, value, options, { url: requestUrl, headers: requestHeaders }));
      return reply;
    },

    clearCookie(name: string, options?: CookieOptions) {
      // The clearing cookie must match the original's attributes, `Secure`
      // included, or the browser treats it as a different cookie and the
      // original survives. Same context in, same flag out.
      setCookies.push(
        serializeCookie(name, "", { ...options, maxAge: 0 }, { url: requestUrl, headers: requestHeaders }),
      );
      return reply;
    },

    async sendFile(filePath: string, options?: SendFileOptions): Promise<Response> {
      sent = true;
      try {
        // Lazy import, keeps reply.ts edge-compatible when sendFile isn't used
        const { extname } = await import("node:path");

        const file = await readConfinedFile(filePath, options);
        if (!file.ok) return fileErrorResponse(file.status, buildHeaders);

        const data = file.data;
        const ext = extname(file.path).toLowerCase();
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

      const opts: DownloadOptions =
        typeof filenameOrOptions === "string" ? { filename: filenameOrOptions } : (filenameOrOptions ?? {});

      // Only the filesystem work is guarded. Wrapping the response construction
      // too is how a real fault (a filename `new Response()` refuses, a bug in
      // header building) got reported as "404 Not Found" for a file that had
      // already been read successfully, which is a lie the caller cannot debug.
      let pathModule: typeof import("node:path");
      let file: ConfinedRead;
      try {
        // Lazy import, keeps reply.ts edge-compatible when download isn't used
        pathModule = await import("node:path");
        // Confined exactly like sendFile: without a root, downloads are limited
        // to the process CWD. Serving outside it requires an explicit root.
        file = await readConfinedFile(filePath, opts);
      } catch {
        return fileErrorResponse(404, buildHeaders);
      }
      if (!file.ok) return fileErrorResponse(file.status, buildHeaders);

      const { extname, basename } = pathModule;
      const ext = extname(file.path).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      // `basename` applies to the caller-supplied name too: it is frequently a
      // value from the request, and `filename="../../x"` is exactly what
      // Content-Disposition's filename parameter is not allowed to carry.
      const downloadName = basename(opts.filename ?? basename(file.path));

      return new Response(file.data, {
        status: statusCode,
        headers: buildHeaders({
          "content-type": contentType,
          "content-disposition": contentDisposition(downloadName),
          ...headers,
        }),
      });
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
