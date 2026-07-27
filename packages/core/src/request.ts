// @celsian/core -- Request builder

import type { CelsianRequest } from "./types.js";

// Shared empty query object for requests with no query string
const EMPTY_QUERY: Record<string, string | string[]> = Object.freeze(Object.create(null));

// Keys that must never be set via user input (prototype pollution prevention)
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Symbol holding the source Web Request on the wrapper (excluded from Object.keys/JSON).
const SRC = Symbol("celsian.srcRequest");

// Shared prototype for fast request wrappers: body-consuming methods and the
// live body/bodyUsed accessors delegate to the source Request via `this[SRC]`.
// Using a prototype avoids per-request `.bind()` (×6) and `Object.defineProperty`
// (×2) -- ~10× cheaper to construct than per-request property definition.
const REQUEST_PROTO = {
  get body() {
    return (this as Record<symbol, Request>)[SRC].body;
  },
  get bodyUsed() {
    return (this as Record<symbol, Request>)[SRC].bodyUsed;
  },
  json() {
    return (this as Record<symbol, Request>)[SRC].json();
  },
  text() {
    return (this as Record<symbol, Request>)[SRC].text();
  },
  formData() {
    return (this as Record<symbol, Request>)[SRC].formData();
  },
  arrayBuffer() {
    return (this as Record<symbol, Request>)[SRC].arrayBuffer();
  },
  blob() {
    return (this as Record<symbol, Request>)[SRC].blob();
  },
  clone() {
    return (this as Record<symbol, Request>)[SRC].clone();
  },
};

/**
 * A syntactically safe authority: `host[:port]`, or a bracketed IPv6 literal.
 *
 * `Host` and `x-forwarded-host` are attacker-controlled strings. Splicing one
 * into a URL unchecked lets `Host: evil.com@real.com` (userinfo), `Host: a/b`
 * (path) or a `Host` with a stray `?`/`#` re-point the parsed URL, or produce a
 * string that throws on the next `new URL()`. Anything not matching is ignored
 * and the transport-level authority is kept.
 */
const SAFE_AUTHORITY = /^(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?$/;

/** A URL scheme token, per RFC 3986: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`. */
const SAFE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;

/** Options controlling how far `x-forwarded-*` is trusted. See `CelsianAppOptions`. */
export interface ForwardedTrustOptions {
  trustProxy?: boolean;
  trustedHosts?: string[];
}

/**
 * The URL the *client* addressed, rebuilt from `rawUrl` plus the request headers.
 *
 * Adapters synthesize `request.url` from the address the server is bound to
 * (`serve()` uses `http://${host}:${port}`), so on a real deployment it reads
 * `http://0.0.0.0:3000/...` no matter what the browser asked for. Every
 * host-sensitive control downstream, the CSRF same-origin check, response-cache
 * keys, absolute redirects, then compares against the bind address instead of
 * the site. This restores the browser's view:
 *
 * - the `Host` header replaces the bind authority (this is what the client sent);
 * - with `trustProxy`, `x-forwarded-proto` sets the scheme;
 * - with `trustProxy`, `x-forwarded-host` replaces the authority *only* when it
 *   appears in the `trustedHosts` allowlist. Un-allowlisted values are ignored,
 *   which is the host-header-injection guard.
 *
 * Deliberately string surgery rather than `new URL()`: this runs on every
 * request, and it returns `rawUrl` itself (same reference, no allocation) in the
 * common case where nothing overrides the transport authority.
 *
 * @param rawUrl The adapter's URL. Relative URLs are returned untouched.
 * @param authorityStart Index of the first authority character (after `://`), or -1.
 * @param authorityEnd Index one past the last authority character.
 */
export function applyForwardedAuthority(
  rawUrl: string,
  authorityStart: number,
  authorityEnd: number,
  headers: Headers,
  options: ForwardedTrustOptions,
): string {
  if (authorityStart < 3) return rawUrl;

  const authority = rawUrl.slice(authorityStart, authorityEnd);
  const scheme = rawUrl.slice(0, authorityStart - 3);
  let nextAuthority = authority;
  let nextScheme = scheme;

  const hostHeader = headers.get("host");
  if (hostHeader !== null && SAFE_AUTHORITY.test(hostHeader)) nextAuthority = hostHeader;

  if (options.trustProxy) {
    // A proxy chain appends, so the left-most entry is the original client's.
    const proto = headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
    if (proto && SAFE_SCHEME.test(proto)) nextScheme = proto;

    const forwardedHost = headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
    if (forwardedHost && SAFE_AUTHORITY.test(forwardedHost) && options.trustedHosts?.includes(forwardedHost) === true) {
      nextAuthority = forwardedHost;
    }
  }

  if (nextAuthority === authority && nextScheme === scheme) return rawUrl;
  return `${nextScheme}://${nextAuthority}${rawUrl.slice(authorityEnd)}`;
}

/**
 * `applyForwardedAuthority` for callers that hold only the URL string, i.e. the
 * paths (WebSocket upgrade, adapters) that are not the request hot path and so
 * have not already scanned it. Locates the authority, then delegates.
 */
export function resolveEffectiveUrl(rawUrl: string, headers: Headers, options: ForwardedTrustOptions): string {
  const schemeSep = rawUrl.indexOf("://");
  if (schemeSep === -1) return rawUrl;
  const authorityStart = schemeSep + 3;
  let authorityEnd = rawUrl.length;
  for (let i = authorityStart; i < rawUrl.length; i++) {
    const code = rawUrl.charCodeAt(i);
    if (code === 47 /* '/' */ || code === 63 /* '?' */ || code === 35 /* '#' */) {
      authorityEnd = i;
      break;
    }
  }
  return applyForwardedAuthority(rawUrl, authorityStart, authorityEnd, headers, options);
}

/**
 * Build a CelsianRequest from a Web Standard Request, parsed URL, and route params.
 * Body-consuming methods are bound to the original Request to preserve internal slots.
 *
 * `url` is authoritative for `request.url`: callers pass the *effective* URL (see
 * {@link resolveEffectiveUrl}), not the adapter's bind-address URL.
 */
export function buildRequest(request: Request, url: URL, params: Record<string, string>): CelsianRequest {
  // Use frozen empty object when there's no query string to avoid per-request allocation
  let query: Record<string, string | string[]>;
  const searchStr = url.search;
  if (!searchStr || searchStr === "?") {
    query = EMPTY_QUERY as Record<string, string | string[]>;
  } else {
    query = Object.create(null);
    for (const [key, value] of url.searchParams) {
      if (BLOCKED_KEYS.has(key)) continue;
      const existing = query[key];
      if (existing !== undefined) {
        query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        query[key] = value;
      }
    }
  }

  // Direct property assignment -- avoids per-property getter closures.
  // Delegate only body-consuming methods that need the original Request's `this`.
  const celsianRequest = Object.create(null) as CelsianRequest;
  const req = celsianRequest as Record<string, unknown>;
  req.headers = request.headers;
  req.method = request.method;
  req.url = url.href;
  req.signal = request.signal;
  req.params = params;
  req.query = query;
  req.parsedBody = undefined;

  // Bind body-consuming methods (they check internal slots on the original Request)
  req.json = request.json.bind(request);
  req.text = request.text.bind(request);
  req.formData = request.formData.bind(request);
  req.arrayBuffer = request.arrayBuffer.bind(request);
  req.blob = request.blob.bind(request);
  req.clone = request.clone.bind(request);

  // Lazy getters for rarely-accessed properties
  Object.defineProperty(celsianRequest, "body", { get: () => request.body, configurable: true, enumerable: true });
  Object.defineProperty(celsianRequest, "bodyUsed", {
    get: () => request.bodyUsed,
    configurable: true,
    enumerable: true,
  });

  // Copy any custom properties set on the request (e.g., env/ctx from Cloudflare adapter)
  for (const key of Object.keys(request)) {
    if (!(key in celsianRequest)) {
      (celsianRequest as Record<string, unknown>)[key] = (request as unknown as Record<string, unknown>)[key];
    }
  }

  return celsianRequest;
}

/**
 * Fast request builder that accepts pre-parsed pathname and query string,
 * avoiding URL object creation on the hot path.
 *
 * `effectiveUrl` is the URL the client actually addressed, as resolved by
 * `CelsianApp.handle` from the `Host` header (and the trusted `x-forwarded-*`
 * headers). It is what `request.url` reports. Passing the source `Request`'s
 * own `url` here would leak the server's *bind* address instead, because
 * `serve()` builds it as `http://${bindHost}:${port}`, and every same-origin
 * check and cache key downstream would then compare against `0.0.0.0`.
 */
export function buildRequestFast(
  request: Request,
  _pathname: string,
  queryString: string,
  params: Record<string, string>,
  effectiveUrl: string,
): CelsianRequest {
  // Parse query string without creating a URL object
  let query: Record<string, string | string[]>;
  if (!queryString) {
    query = EMPTY_QUERY as Record<string, string | string[]>;
  } else {
    query = Object.create(null);
    // Use URLSearchParams for correct parsing (handles encoding, +, etc.)
    const searchParams = new URLSearchParams(queryString);
    for (const [key, value] of searchParams) {
      if (BLOCKED_KEYS.has(key)) continue;
      const existing = query[key];
      if (existing !== undefined) {
        query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        query[key] = value;
      }
    }
  }

  // Construct from a shared prototype: body/bodyUsed and the body-consuming
  // methods delegate to the source Request via `this[SRC]`. This avoids 6
  // per-request `.bind()` calls and 2 `Object.defineProperty` calls (~10× cheaper).
  const celsianRequest = Object.create(REQUEST_PROTO) as CelsianRequest;
  const req = celsianRequest as unknown as Record<string | symbol, unknown>;
  req[SRC] = request;
  req.headers = request.headers;
  req.method = request.method;
  req.url = effectiveUrl;
  req.signal = request.signal;
  req.params = params;
  req.query = query;
  req.parsedBody = undefined;

  // Copy any custom properties set on the request (e.g., env/ctx from Cloudflare adapter)
  const requestKeys = Object.keys(request);
  if (requestKeys.length > 0) {
    for (const key of requestKeys) {
      if (!(key in celsianRequest)) {
        (celsianRequest as Record<string, unknown>)[key] = (request as unknown as Record<string, unknown>)[key];
      }
    }
  }

  return celsianRequest;
}
