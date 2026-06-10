// @celsian/core — CSRF protection plugin (double-submit cookie pattern)

import { parseCookies, serializeCookie } from "../cookie.js";
import type { CelsianReply, CelsianRequest, HookHandler, PluginFunction } from "../types.js";

export interface CSRFOptions {
  /** Cookie name for the CSRF token (default: '_csrf') */
  cookieName?: string;
  /** Header name to check on mutating requests (default: 'x-csrf-token') */
  headerName?: string;
  /** Token byte length (default: 32) */
  tokenLength?: number;
  /** Cookie options */
  cookie?: {
    path?: string;
    secure?: boolean;
    sameSite?: "strict" | "lax" | "none";
    domain?: string;
  };
  /** Methods that require CSRF validation (default: POST, PUT, PATCH, DELETE) */
  protectedMethods?: string[];
  /**
   * Paths to exclude from CSRF checks (e.g., webhook endpoints).
   * Each entry matches exactly OR as a path-segment prefix:
   * `'/_rpc'` excludes `/_rpc` and `/_rpc/math.multiply`, but NOT `/_rpcx`.
   * A trailing `/*` is also supported explicitly: `'/_rpc/*'`.
   */
  excludePaths?: string[];
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Generate a cryptographically random token using crypto.getRandomValues().
 */
function generateToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Check whether a pathname matches an exclude entry: exact match, or
 * path-segment prefix (`/_rpc` matches `/_rpc/...` but not `/_rpcx`).
 * Trailing `/*` is normalized to the same segment-prefix semantics.
 */
function isPathExcluded(pathname: string, excludePaths: string[]): boolean {
  for (const entry of excludePaths) {
    // Normalize: '/_rpc/*' → '/_rpc', '/_rpc/' → '/_rpc'
    let base = entry;
    if (base.endsWith("/*")) base = base.slice(0, -2);
    if (base.endsWith("/") && base !== "/") base = base.slice(0, -1);
    if (base === "" || base === "/") {
      // Root entry excludes everything
      return true;
    }
    if (pathname === base || pathname.startsWith(`${base}/`)) return true;
  }
  return false;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i]! ^ bufB[i]!;
  }
  return result === 0;
}

export function csrf(options: CSRFOptions = {}): PluginFunction {
  const cookieName = options.cookieName ?? "_csrf";
  const headerName = options.headerName ?? "x-csrf-token";
  const tokenLength = options.tokenLength ?? 32;
  const cookieOpts = options.cookie ?? {};
  const protectedMethods = new Set(options.protectedMethods ?? [...MUTATING_METHODS]);
  const excludePaths = options.excludePaths ?? [];

  return function csrfPlugin(app) {
    const hook: HookHandler = (request: CelsianRequest, reply: CelsianReply) => {
      const method = request.method.toUpperCase();
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Skip excluded paths (exact or path-segment prefix match)
      if (excludePaths.length > 0 && isPathExcluded(pathname, excludePaths)) return;

      // On safe methods (GET, HEAD, OPTIONS), set the CSRF cookie if not present
      if (!protectedMethods.has(method)) {
        const cookies = parseCookies(request.headers.get("cookie") ?? "");
        if (!cookies[cookieName]) {
          const token = generateToken(tokenLength);
          const cookieStr = serializeCookie(cookieName, token, {
            path: cookieOpts.path ?? "/",
            // Secure by default in production (matches serializeCookie's policy);
            // explicit cookie.secure overrides. Sent over HTTPS only in prod.
            secure: cookieOpts.secure ?? process.env.NODE_ENV === "production",
            sameSite: cookieOpts.sameSite ?? "lax",
            domain: cookieOpts.domain,
            httpOnly: false, // Must be readable by JS to send in header (double-submit)
          });
          reply.header("set-cookie", cookieStr);
        }
        return;
      }

      // On mutating methods, validate X-CSRF-Token header matches the cookie
      const cookies = parseCookies(request.headers.get("cookie") ?? "");
      const cookieToken = cookies[cookieName];
      const headerToken = request.headers.get(headerName);

      if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
        return reply.status(403).json({
          error: "CSRF token mismatch",
          statusCode: 403,
        });
      }
    };

    app.addHook("onRequest", hook);
  };
}
