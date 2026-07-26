// @celsian/core, CSRF protection plugin (double-submit cookie pattern)

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
   * Secret used to sign tokens (HMAC-SHA256). Defaults to a random
   * per-process secret, which is fine for a single instance but rotates on
   * restart and is not shared across a fleet, so set it explicitly in production.
   */
  secret?: string;
  /**
   * Return the session identifier the CSRF token should be bound to.
   * Without this, a token is signed but bound to the empty session, which stops
   * forged tokens but not an attacker who can write the cookie AND set the
   * header. Bind to the session id to close that, and to make the token
   * self-rotating: a token minted before login stops verifying after it.
   */
  getSessionId?: (request: CelsianRequest) => string | undefined;
  /**
   * Additional origins accepted on mutating requests. The request's own origin
   * is always accepted.
   */
  trustedOrigins?: string[];
  /**
   * Verify Origin / Sec-Fetch-Site on mutating requests (default: true).
   * Defense in depth: a cookie written by a sibling subdomain still cannot
   * drive a cross-site POST.
   */
  checkOrigin?: boolean;
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
  return toHex(bytes);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** HMAC-SHA256 over `<nonce>.<sessionId>`, truncated to 128 bits of hex. */
async function signNonce(key: CryptoKey, nonce: string, sessionId: string): Promise<string> {
  const encoder = new TextEncoder();
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${nonce}.${sessionId}`));
  return toHex(new Uint8Array(mac, 0, 16));
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
  const getSessionId = options.getSessionId;
  const trustedOrigins = new Set(options.trustedOrigins ?? []);
  const checkOrigin = options.checkOrigin !== false;

  // A random per-process secret when none is configured: still unforgeable,
  // just not stable across restarts or across instances.
  const secret = options.secret ?? generateToken(32);
  let keyPromise: Promise<CryptoKey> | null = null;
  function hmacKey(): Promise<CryptoKey> {
    keyPromise ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return keyPromise;
  }

  /** Mint `<nonce>.<hmac>` bound to the current session id. */
  async function issueToken(sessionId: string): Promise<string> {
    const nonce = generateToken(tokenLength);
    return `${nonce}.${await signNonce(await hmacKey(), nonce, sessionId)}`;
  }

  /** True when `token` was minted by us for exactly this session id. */
  async function verifyToken(token: string, sessionId: string): Promise<boolean> {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return false;
    const nonce = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = await signNonce(await hmacKey(), nonce, sessionId);
    return timingSafeEqual(signature, expected);
  }

  return function csrfPlugin(app) {
    const hook: HookHandler = async (request: CelsianRequest, reply: CelsianReply) => {
      const method = request.method.toUpperCase();
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Skip excluded paths (exact or path-segment prefix match)
      if (excludePaths.length > 0 && isPathExcluded(pathname, excludePaths)) return;

      const sessionId = getSessionId?.(request) ?? "";

      // On safe methods (GET, HEAD, OPTIONS), issue a token whenever the one
      // presented is missing or no longer bound to this session. Re-issuing on
      // a session change is what makes a pre-login token useless after login.
      if (!protectedMethods.has(method)) {
        const cookies = parseCookies(request.headers.get("cookie") ?? "");
        const existing = cookies[cookieName];
        if (!existing || !(await verifyToken(existing, sessionId))) {
          const token = await issueToken(sessionId);
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

      // Defense in depth: reject obvious cross-site submissions before even
      // looking at the token. A cookie planted by a sibling host cannot help an
      // attacker whose request announces itself as cross-site.
      if (checkOrigin) {
        const secFetchSite = request.headers.get("sec-fetch-site");
        if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
          return reply.status(403).json({ error: "CSRF origin mismatch", statusCode: 403 });
        }
        const origin = request.headers.get("origin");
        if (origin && origin !== "null") {
          let originHost: string;
          try {
            originHost = new URL(origin).host;
          } catch {
            return reply.status(403).json({ error: "CSRF origin mismatch", statusCode: 403 });
          }
          if (originHost !== url.host && !trustedOrigins.has(origin) && !trustedOrigins.has(originHost)) {
            return reply.status(403).json({ error: "CSRF origin mismatch", statusCode: 403 });
          }
        }
      }

      // On mutating methods the header must match the cookie AND the token must
      // carry our signature over the current session id. Equality alone is a
      // plain double-submit check, which anyone able to write a cookie on the
      // registrable domain can satisfy.
      const cookies = parseCookies(request.headers.get("cookie") ?? "");
      const cookieToken = cookies[cookieName];
      const headerToken = request.headers.get(headerName);

      if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
        return reply.status(403).json({
          error: "CSRF token mismatch",
          statusCode: 403,
        });
      }

      if (!(await verifyToken(cookieToken, sessionId))) {
        return reply.status(403).json({
          error: "CSRF token mismatch",
          statusCode: 403,
        });
      }
    };

    app.addHook("onRequest", hook);
  };
}
