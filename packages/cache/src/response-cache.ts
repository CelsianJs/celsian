// @celsian/cache, HTTP response caching

import type { KVStore } from "./store.js";

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  /**
   * Response body.
   *
   * Base64 when {@link CachedResponse.encoding} is `"base64"`, which is what
   * this cache always writes now. Entries written by an older release have no
   * `encoding` and hold the body as UTF-8 text; they are still replayed, as
   * text, so an upgrade does not have to cold-start the store.
   */
  body: string;
  /** Body encoding. Absent on entries written before binary-safe storage. */
  encoding?: "base64";
  cachedAt: number;
}

interface StoredResponse extends CachedResponse {
  /** Full base for invalidation when the store key's readable head is truncated. */
  keyBase?: string;
}

export interface ResponseCacheOptions {
  /** KV store to use for caching */
  store: KVStore;
  /** Default TTL in milliseconds (default: 60_000) */
  ttlMs?: number;
  /** Cache key generator. Default: `${method}:${host}:${pathname}${normalizedQuery}` */
  keyGenerator?: (request: Request) => string;
  /**
   * Allow-list of query parameters that participate in the default cache key.
   * Everything else is dropped.
   *
   * Without this, an unauthenticated flood of `?cachebust=1`, `?cachebust=2`,
   * ... mints an unbounded number of distinct keys and evicts the entries you
   * actually wanted cached. Set this to the parameters your handler reads.
   * Ignored when a custom `keyGenerator` is supplied.
   */
  queryParams?: string[];
  /**
   * Maximum stored cache key length in characters (default: 512).
   *
   * Keys are HASHED, so this is a formatting budget and never a functional
   * limit: a long URL or a long partitioned header shortens the human-readable
   * part of the key rather than disabling the cache for that request.
   */
  maxKeyLength?: number;
  /** Which HTTP methods to cache (default: ['GET', 'HEAD']) */
  methods?: string[];
  /** Which status codes to cache (default: [200]) */
  statusCodes?: number[];
  /** Paths to exclude from caching */
  exclude?: string[];
  /** Key prefix in the store (default: 'rc:') */
  prefix?: string;
  /** Headers to include in cache key for content negotiation (default: []) */
  varyHeaders?: string[];
  /** Additional credential-bearing request headers that bypass the shared cache */
  credentialHeaders?: string[];
  /**
   * Extra request headers to treat as public, i.e. as carrying no credential.
   *
   * Any request header that is neither known-public nor keyed makes the request
   * "possibly credentialed", and a possibly-credentialed request only
   * participates in the cache for a response that is explicitly public (see
   * {@link ResponseCacheOptions.credentialHeaders} and the README section
   * "Credentials and privacy"). List your infrastructure's own harmless headers
   * (`cf-ray`, `x-request-id`, ...) here to keep those requests cacheable.
   */
  publicHeaders?: string[];
}

const DEFAULT_OPTIONS = {
  ttlMs: 60_000,
  methods: ["GET", "HEAD"],
  statusCodes: [200],
  prefix: "rc:",
  maxKeyLength: 512,
};

/** Hex characters of SHA-256 kept in a cache key (128 bits). */
const DIGEST_LENGTH = 32;
/**
 * Separator between the readable head of an over-long key and its digest.
 *
 * `#` cannot occur in a generated key: `URL` percent-encodes it in a pathname
 * and `encodeURIComponent` does in the query, so the two key forms can never be
 * confused for one another.
 */
const HASH_MARKER = "#sha256=";

/**
 * Request headers that rewrite the host/scheme a handler believes it is serving.
 *
 * These are the canonical web-cache-poisoning vectors: a handler that builds an
 * absolute URL from `X-Forwarded-Host` reflects an attacker-chosen host into the
 * response, and a single unauthenticated request then serves
 * `<script src="https://evil.example/app.js">` to every anonymous visitor for
 * the whole TTL. They are partitioned EAGERLY (like `origin`) because the
 * response that would tell us to vary on them is not available at lookup time.
 *
 * `host` leads the list because it is the ORIGINAL of all of them and was
 * missing: the key took its authority from `request.url`, which on a server
 * bound to `0.0.0.0` is the BIND address and therefore identical for every
 * tenant. Scheme and host were put in the key precisely to stop one process
 * serving several domains from cross-serving bodies, and without the real
 * `Host` header in the key that partition collapsed to a single bucket.
 *
 * A DENYLIST CANNOT BE COMPLETE. Reverse proxies, CDNs, and frameworks invent
 * host-rewrite headers freely, and this cache cannot know which header your
 * handler happens to read. Any request header your handler reflects into a
 * response MUST be listed in `varyHeaders`. See the README section
 * "Cache poisoning and varyHeaders".
 */
const HOST_REWRITE_HEADERS = [
  // The authority the client actually addressed. See above.
  "host",
  // RFC 7239, the standard header. Its `host=`/`proto=` parameters are the
  // canonical form of everything below it.
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-scheme",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-forwarded-prefix",
  "x-forwarded-uri",
  "x-forwarded-ssl",
  "x-host",
  "x-http-host-override",
  "x-original-host",
  "x-original-url",
  "x-original-uri",
  "x-rewrite-url",
];

/**
 * Denylist of per-user / credential-bearing headers that MUST NOT be cached.
 *
 * A response cache replays a single stored response to many users, so any
 * header carrying a user's identity or credentials would leak to everyone
 * hitting the cache. We deny exactly those headers and preserve everything
 * else, representation headers (`content-type`, `etag`, ...), CORS headers,
 * and importantly the security headers (`x-content-type-options`,
 * `x-frame-options`, `content-security-policy`, `strict-transport-security`,
 * ...) that `onSend`/security plugins attach and that a cached response must
 * keep carrying. An allowlist would silently strip those, so we denylist.
 */
const NON_CACHEABLE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "proxy-authenticate",
  "x-cache",
]);

/**
 * Request headers known NOT to carry a credential.
 *
 * The credential check is an ALLOW-list because the previous three-entry
 * denylist (`authorization`, `cookie`, `proxy-authorization`) failed OPEN: it
 * missed `x-api-key`, `x-auth-token`, `x-session-id` and every other auth
 * transport, so one user's API-keyed response was stored and replayed to the
 * next user. The same reasoning the host-rewrite list is documented with, a
 * denylist of attacker-chosen header names cannot be complete, applies with
 * more force here, because the consequence is reading someone else's data.
 *
 * A request carrying any header outside this list (plus the configured
 * `varyHeaders`, the eagerly-partitioned host-rewrite headers, and
 * `publicHeaders`) is treated as possibly credentialed. That does not disable
 * caching for it, it requires the response to say `Cache-Control: public` or
 * `s-maxage=N` before it is stored or replayed, which is exactly RFC 9111's
 * rule for authenticated requests.
 */
const PUBLIC_REQUEST_HEADERS = new Set([
  "accept",
  "accept-charset",
  "accept-datetime",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "device-memory",
  "dnt",
  "downlink",
  "dpr",
  "early-data",
  "ect",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "keep-alive",
  "max-forwards",
  "origin",
  "pragma",
  "priority",
  "purpose",
  "range",
  "referer",
  "rtt",
  "save-data",
  "sec-ch-ua",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-mobile",
  "sec-ch-ua-model",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "sec-gpc",
  "sec-purpose",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade-insecure-requests",
  "user-agent",
  "via",
  "viewport-width",
  "width",
  "x-forwarded-for",
  "x-real-ip",
  "x-requested-with",
]);

const DEFAULT_CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const PRIVATE_RESPONSE_HEADERS = ["set-cookie", "set-cookie2", "authorization", "proxy-authorization"];
// `no-cache` permits storage only when every reuse is revalidated. This cache
// has no validator/revalidation path, so storing it would turn the next request
// into an invalid HIT. Fail closed and call the origin handler every time.
const SHARED_CACHE_PROHIBITED_DIRECTIVES = new Set(["private", "no-store", "no-cache"]);
const REQUEST_CACHE_BYPASS_DIRECTIVES = new Set(["no-store", "no-cache"]);
const PUBLIC_DIRECTIVE = new Set(["public"]);

function hasDirective(value: string | null, directives: Set<string>): boolean {
  if (!value) return false;

  return value.split(",").some((part) => {
    const directive = part.trim().toLowerCase().split("=", 1)[0]?.trim();
    return directive ? directives.has(directive) : false;
  });
}

/** Read a numeric cache directive. Returns NaN when present but unparseable. */
function directiveSeconds(value: string | null, name: string): number | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const [rawName, ...rawValueParts] = part.split("=");
    if (rawName?.trim().toLowerCase() !== name) continue;
    const raw = rawValueParts.join("=").trim().replace(/^"|"$/g, "");
    if (!/^\d+$/.test(raw)) return Number.NaN;
    return Number(raw);
  }
  return null;
}

function hasZeroMaxAge(value: string | null): boolean {
  return directiveSeconds(value, "max-age") === 0 || directiveSeconds(value, "s-maxage") === 0;
}

/**
 * Is this response explicitly marked as shareable with anyone?
 *
 * RFC 9111 section 3.5 lets a shared cache store a response to a request with
 * credentials only when the response says so explicitly. `must-revalidate` is
 * deliberately NOT accepted, this cache has no revalidation path.
 */
function isExplicitlyPublic(cacheControl: string | null): boolean {
  if (hasDirective(cacheControl, PUBLIC_DIRECTIVE)) return true;
  const sMaxAge = directiveSeconds(cacheControl, "s-maxage");
  return sMaxAge !== null && !Number.isNaN(sMaxAge) && sMaxAge > 0;
}

function hasPragmaNoCache(value: string | null): boolean {
  return (
    value
      ?.toLowerCase()
      .split(",")
      .some((token) => token.trim() === "no-cache") === true
  );
}

/**
 * Freshness the response declares for itself, in milliseconds.
 *
 * `number` is an explicit lifetime, `null` means "already stale, do not store",
 * and `undefined` means the response said nothing and the configured TTL
 * applies. Ignoring this stored a `max-age=1` response for the configured 60s,
 * 60x longer than the origin allowed.
 */
function declaredFreshnessMs(cacheControl: string | null, expires: string | null): number | null | undefined {
  const sMaxAge = directiveSeconds(cacheControl, "s-maxage");
  const maxAge = directiveSeconds(cacheControl, "max-age");
  // s-maxage overrides max-age for a shared cache.
  const seconds = sMaxAge ?? maxAge;
  if (seconds !== null) {
    if (Number.isNaN(seconds) || seconds <= 0) return null;
    return seconds * 1000;
  }

  if (expires === null) return undefined;
  const at = Date.parse(expires);
  // An unparseable Expires (`0`, `-1`, garbage) means "already expired".
  if (Number.isNaN(at)) return null;
  const remaining = at - Date.now();
  return remaining > 0 ? remaining : null;
}

function hasWildcardVary(value: string | null): boolean {
  return value?.split(",").some((header) => header.trim() === "*") ?? false;
}

function parseVary(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
}

function mergeVary(existing: string | null, configured: string[]): string | null {
  const fields = existing
    ? existing
        .split(",")
        .map((header) => header.trim())
        .filter(Boolean)
    : [];
  const seen = new Set(fields.map((header) => header.toLowerCase()));

  for (const header of configured) {
    if (!seen.has(header.toLowerCase())) {
      fields.push(header);
      seen.add(header.toLowerCase());
    }
  }

  return fields.length > 0 ? fields.join(", ") : null;
}

/** Base64-encode bytes without assuming a Node Buffer (workers have none). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The `METHOD:authority:/path?query` parts of a stored key, for `invalidate()`. */
interface KeyBase {
  method: string | null;
  authority: string | null;
  path: string;
}

function splitBase(base: string): KeyBase {
  const separator = base.indexOf(":");
  if (separator < 0) return { method: null, authority: null, path: base };

  const method = base.slice(0, separator);
  const rest = base.slice(separator + 1);
  // The authority is `scheme//host[:port]` and the path segment starts at the
  // `:/` that follows it. Scanning for `:/` rather than splitting on every `:`
  // is what keeps `https//localhost:3000` from being mistaken for the path.
  const pathStart = rest.indexOf(":/");
  if (pathStart < 0) return { method, authority: null, path: rest };
  return { method, authority: rest.slice(0, pathStart), path: rest.slice(pathStart + 1) };
}

/**
 * Create a response cache handler.
 *
 * Returns a function that wraps a fetch handler with caching.
 * This works at the adapter level, not as a hook, because it needs
 * to intercept and cache the full Response.
 *
 * Usage:
 * ```ts
 * const cache = createResponseCache({ store: new MemoryKVStore() });
 *
 * // Wrap the app handler
 * const cachedHandler = cache.wrap(app.handle.bind(app));
 *
 * // Or use manually in routes
 * app.get('/data', async (req, reply) => {
 *   return cache.cached(req, async () => {
 *     const data = await expensiveQuery();
 *     return reply.json(data);
 *   });
 * });
 * ```
 */
export function createResponseCache(options: ResponseCacheOptions) {
  const store = options.store;
  const ttlMs = options.ttlMs ?? DEFAULT_OPTIONS.ttlMs;
  const methods = options.methods ?? DEFAULT_OPTIONS.methods;
  const statusCodes = options.statusCodes ?? DEFAULT_OPTIONS.statusCodes;
  const exclude = options.exclude ?? [];
  const prefix = options.prefix ?? DEFAULT_OPTIONS.prefix;
  const varyHeaders = options.varyHeaders ?? [];
  // `origin` stays first so the readable part of a key stays stable.
  // `accept-encoding` is represented so a compressed response (`Vary:
  // Accept-Encoding`, which `compress()` sets) is storable at all: without it
  // every compressed response failed the "every Vary field is in the key" check
  // and the cache silently did nothing.
  const representedVaryHeaders = new Set([
    "origin",
    "accept-encoding",
    ...HOST_REWRITE_HEADERS,
    ...varyHeaders.map((header) => header.toLowerCase()),
  ]);
  const credentialHeaders = new Set(
    [...DEFAULT_CREDENTIAL_HEADERS, ...(options.credentialHeaders ?? [])].map((header) => header.toLowerCase()),
  );
  // A header that is keyed (partitioned) cannot leak across requests, and a
  // header the application declared public is the application's call.
  const publicHeaders = new Set(
    [
      ...PUBLIC_REQUEST_HEADERS,
      ...representedVaryHeaders,
      ...(options.publicHeaders ?? []).map((header) => header.toLowerCase()),
    ].filter((header) => !credentialHeaders.has(header)),
  );
  const queryParams = options.queryParams ? new Set(options.queryParams) : null;
  const maxKeyLength = options.maxKeyLength ?? DEFAULT_OPTIONS.maxKeyLength;
  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;
  /** In-flight origin executions, keyed by cache key (stampede protection). */
  const inFlight = new Map<string, Promise<unknown>>();

  /**
   * Sort (and optionally filter) the query string so `?b=1&a=2` and `?a=2&b=1`
   * share one entry instead of two, and so unknown cache-busting parameters can
   * be dropped entirely.
   */
  function normalizeSearch(url: URL): string {
    const params = [...url.searchParams.entries()].filter(([name]) => !queryParams || queryParams.has(name));
    if (params.length === 0) return "";
    // Stable name-only sorting preserves get()/getAll() semantics for repeated
    // parameters while still sharing entries across distinct-name reordering.
    params.sort((a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1));
    return `?${params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&")}`;
  }

  function defaultKeyGenerator(request: Request): string {
    const url = new URL(request.url);
    // The SCHEME and HOST are part of the key. One process serving several
    // domains shares a single store, so keying on the path alone served
    // tenant-a's body to tenant-b, and omitting the scheme let
    // `http://x.app/data` and `https://x.app/data` share one entry even though a
    // handler can serve them differently (canonical links, secure-only content).
    // The scheme is joined to the host with `//` rather than `://` so the
    // authority stays a SINGLE colon-delimited segment, which is what
    // `invalidate()`'s host-less key form parses against.
    //
    // `request.url` alone is NOT enough: on a server bound to `0.0.0.0` its
    // authority is the bind address for every tenant. The real `Host` header is
    // partitioned separately (see HOST_REWRITE_HEADERS), so the two together
    // always separate tenants even when one of them is degenerate.
    const scheme = url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol;
    return `${request.method}:${scheme}//${url.host}:${url.pathname}${normalizeSearch(url)}`;
  }

  /**
   * Build the store key.
   *
   * A key within the length budget is stored verbatim. A longer one keeps as
   * much of its readable head as fits and ends in a SHA-256 digest of the whole
   * logical key, so it stays unique while its stored length is bounded.
   *
   * Over-long keys are HASHED rather than rejected. Rejecting them meant ~250
   * bytes of `Origin:` pushed a key over the budget, and an over-budget key
   * skipped the read, the write AND the single-flight, so one header turned the
   * cache (and its stampede protection) off for any URL an attacker chose.
   * Hashing is on the slow path only: a digest costs ~20us, which would
   * otherwise be paid by every cache hit.
   */
  async function cacheKeyForRequest(request: Request): Promise<{ key: string; keyBase?: string }> {
    const readable = keyGenerator(request);
    // Reflected CORS responses carry `Vary: Origin`, but the response is not
    // available when the lookup key is created. Partition Origin eagerly so
    // neither the body nor Access-Control-Allow-Origin can cross origins.
    let logical = readable;
    for (const header of representedVaryHeaders) {
      logical += `|${header}=${encodeURIComponent(request.headers.get(header) ?? "")}`;
    }

    const plain = prefix + logical;
    if (plain.length <= maxKeyLength) return { key: plain };

    const digest = (await sha256Hex(logical)).slice(0, DIGEST_LENGTH);
    const budget = Math.max(0, maxKeyLength - prefix.length - HASH_MARKER.length - DIGEST_LENGTH);
    return { key: `${prefix}${readable.slice(0, budget)}${HASH_MARKER}${digest}`, keyBase: readable };
  }

  function isExcluded(pathname: string): boolean {
    return exclude.some((p) => pathname.startsWith(p));
  }

  /**
   * Does this request plausibly carry a credential?
   *
   * Fails CLOSED: an unrecognized header counts. A shared cache that guesses
   * wrong here hands one user's data to another.
   */
  function isPossiblyCredentialed(request: Request): boolean {
    for (const [name] of request.headers) {
      const header = name.toLowerCase();
      if (credentialHeaders.has(header)) return true;
      if (!publicHeaders.has(header)) return true;
    }
    return false;
  }

  function canStoreSharedResponse(response: Response, credentialed: boolean): boolean {
    const cacheControl = response.headers.get("cache-control");
    if (hasDirective(cacheControl, SHARED_CACHE_PROHIBITED_DIRECTIVES) || hasZeroMaxAge(cacheControl)) {
      return false;
    }
    // HTTP/1.0 caches only understand Pragma; honouring it costs nothing and an
    // origin that sends it plainly does not want the response shared.
    if (hasPragmaNoCache(response.headers.get("pragma"))) {
      return false;
    }
    if (declaredFreshnessMs(cacheControl, response.headers.get("expires")) === null) {
      return false;
    }
    if (credentialed && !isExplicitlyPublic(cacheControl)) {
      return false;
    }
    if (hasWildcardVary(response.headers.get("vary"))) {
      return false;
    }
    if (parseVary(response.headers.get("vary")).some((header) => !representedVaryHeaders.has(header))) {
      return false;
    }
    return !PRIVATE_RESPONSE_HEADERS.some((header) => response.headers.has(header));
  }

  function canReplaySharedResponse(cached: CachedResponse): boolean {
    const cacheControl = cached.headers["cache-control"] ?? null;
    if (hasDirective(cacheControl, SHARED_CACHE_PROHIBITED_DIRECTIVES) || hasZeroMaxAge(cacheControl)) {
      return false;
    }
    if (hasPragmaNoCache(cached.headers.pragma ?? null)) {
      return false;
    }
    if (hasWildcardVary(cached.headers.vary ?? null)) {
      return false;
    }
    if (parseVary(cached.headers.vary ?? null).some((header) => !representedVaryHeaders.has(header))) {
      return false;
    }
    // `in` walks the prototype chain, so a header literally named `constructor`
    // or `toString` matched on Object.prototype and made every entry look
    // private. Own keys only.
    return !PRIVATE_RESPONSE_HEADERS.some((header) => Object.hasOwn(cached.headers, header));
  }

  /**
   * Check cache for a request, or execute handler and cache the result.
   */
  async function cached(
    request: Request,
    handler: () => Response | Promise<Response>,
    customTtlMs?: number,
  ): Promise<Response> {
    const method = request.method.toUpperCase();

    // Only cache specified methods
    if (!methods.includes(method)) {
      return handler();
    }

    const url = new URL(request.url);
    if (isExcluded(url.pathname)) {
      return handler();
    }

    // This is a shared response cache. A request that may carry a credential
    // only participates in it for a response the origin marked explicitly
    // public, so a personalized response can neither be stored nor replayed.
    const credentialed = isPossiblyCredentialed(request);

    const requestCacheControl = request.headers.get("cache-control");
    // A client asking for revalidation must not be served the stored entry.
    // It does NOT get to skip the single-flight below, nor to suppress the
    // write: honouring either would let one client-chosen header turn N
    // concurrent requests into N origin executions, which is the amplification
    // a shared cache exists to prevent. Measured before this change: 1 origin
    // execution per 100 requests normally, 100 per 100 with `no-cache`, 50 per
    // 50 with `Pragma: no-cache`.
    //
    // This deliberately deviates from RFC 9111 section 5.2.1.5 for request
    // `no-store`, which is treated as `no-cache` here. Nothing private can be
    // exposed by it: only a response that already passed the shared-cache
    // storability rules (nothing per-user, explicitly public when the request
    // carried anything credential-like) is ever written.
    const bypassRead =
      hasDirective(requestCacheControl, REQUEST_CACHE_BYPASS_DIRECTIVES) ||
      hasZeroMaxAge(requestCacheControl) ||
      hasPragmaNoCache(request.headers.get("pragma"));

    const { key: cacheKey, keyBase } = await cacheKeyForRequest(request);

    /** Replay a stored entry. */
    const replay = (entry: CachedResponse): Response => {
      const body = entry.encoding === "base64" ? base64ToBytes(entry.body) : entry.body;
      return new Response(method === "HEAD" ? null : body, {
        status: entry.status,
        headers: { ...entry.headers, "x-cache": "HIT" },
      });
    };

    /** May this stored entry be served to THIS request? */
    const canServe = (entry: CachedResponse): boolean =>
      canReplaySharedResponse(entry) && (!credentialed || isExplicitlyPublic(entry.headers["cache-control"] ?? null));

    // Check cache
    const stored = bypassRead ? undefined : await store.get<CachedResponse>(cacheKey);
    if (stored) {
      // Defend against entries written by an older release that stored a
      // response requiring revalidation. Never promote such an entry to HIT.
      if (!canReplaySharedResponse(stored)) {
        await store.delete(cacheKey);
      } else if (canServe(stored)) {
        return replay(stored);
      }
    }

    // Stampede protection (single-flight). N concurrent requests for one cold
    // key previously meant N origin executions. Wait for the in-flight one, then
    // re-read: if it stored an entry we serve that, otherwise (it turned out to
    // be non-storable) we fall through and execute the handler ourselves rather
    // than sharing a response that was never eligible for sharing.
    const pending = inFlight.get(cacheKey);
    if (pending) {
      const waitingSince = Date.now();
      await pending.catch(() => undefined);
      const coalesced = await store.get<CachedResponse>(cacheKey);
      // A revalidating request may be served the entry the leader JUST fetched
      // from the origin (that is a fresh origin response, arriving while it
      // waited) but never an older one it explicitly asked to bypass.
      const freshEnough = !bypassRead || (coalesced !== undefined && coalesced.cachedAt >= waitingSince);
      if (coalesced && freshEnough && canServe(coalesced)) {
        return replay(coalesced);
      }
    }

    /**
     * Execute the origin handler and store the result. Published on `inFlight`
     * as a WHOLE, including the `store.set`, so a coalescing caller that
     * awaits it is guaranteed to see the entry when it re-reads.
     */
    async function executeAndStore(): Promise<Response> {
      const response = await handler();

      // Only cache successful responses
      if (!statusCodes.includes(response.status)) {
        return response;
      }

      // Respect response-side shared-cache prohibitions before reading the body.
      // Stripping Set-Cookie or Authorization alone is insufficient because the
      // personalized response body could still be replayed to another user.
      if (!canStoreSharedResponse(response, credentialed)) {
        return response;
      }

      // Store BYTES, not text. Round-tripping the body through `.text()`
      // replaced every invalid UTF-8 sequence with U+FFFD, and because the
      // outgoing response was rebuilt from that string it destroyed images,
      // fonts, PDFs, protobuf and gzip bodies on the MISS as well as the HIT.
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      const replayHeaders = new Headers(response.headers);
      const mergedVary = mergeVary(replayHeaders.get("vary"), varyHeaders);
      if (mergedVary) replayHeaders.set("vary", mergedVary);

      const responseHeaders: Record<string, string> = {};
      replayHeaders.forEach((value, key) => {
        // Persist all representation/security headers; drop only the per-user
        // credential-bearing ones (set-cookie, authorization, ...) which would
        // otherwise be replayed to other users on a cache HIT.
        if (!NON_CACHEABLE_HEADERS.has(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      });

      // Never outlive the freshness the origin declared for itself.
      const configuredTtl = customTtlMs ?? ttlMs;
      const declared = declaredFreshnessMs(replayHeaders.get("cache-control"), replayHeaders.get("expires"));
      const effectiveTtl = typeof declared === "number" ? Math.min(configuredTtl, declared) : configuredTtl;

      await store.set<StoredResponse>(
        cacheKey,
        {
          status: response.status,
          headers: responseHeaders,
          body: bytesToBase64(bytes),
          encoding: "base64",
          cachedAt: Date.now(),
          ...(keyBase === undefined ? {} : { keyBase }),
        },
        effectiveTtl,
      );

      // Add cache miss header
      const newHeaders = new Headers(replayHeaders);
      newHeaders.set("x-cache", "MISS");

      return new Response(bytes, {
        status: response.status,
        headers: newHeaders,
      });
    }

    const execution = executeAndStore();
    inFlight.set(cacheKey, execution);
    try {
      return await execution;
    } finally {
      // Only clear our own entry, a later request may already have replaced it.
      if (inFlight.get(cacheKey) === execution) inFlight.delete(cacheKey);
    }
  }

  /**
   * Wrap a fetch-compatible handler with caching.
   */
  function wrap(handler: (request: Request) => Response | Promise<Response>): (request: Request) => Promise<Response> {
    return (request: Request) => cached(request, () => handler(request));
  }

  /**
   * Invalidate a specific cache key, across every partition and query variant.
   *
   * Accepts either the full generated form (`GET:https//example.com:/data`) or
   * the host-less `GET:/data`, so call sites written before the scheme and host
   * became part of the key keep working. A key WITHOUT a query string purges
   * every query variant of that path: it used to purge only the exact
   * query-less entry while returning `true`, so a post-write purge reported
   * success and left `?page=2` serving stale data.
   */
  async function invalidate(key: string): Promise<boolean> {
    const keys = await store.keys();
    const targetHasQuery = key.includes("?");

    const deleted = await Promise.all(
      keys.map(async (candidate) => {
        if (!candidate.startsWith(prefix)) return false;
        // Recover the readable base: drop the `#sha256=` tail of a hashed key,
        // then the eager `|header=value` partitions of a verbatim one.
        const rest = candidate.slice(prefix.length);
        const marker = rest.indexOf(HASH_MARKER);
        // Keep identity in the entry, not a process-local index: another cache
        // instance sharing this store must invalidate long paths too. Old entries
        // without metadata retain the readable-prefix matching they had before.
        const storedBase = marker >= 0 ? (await store.get<StoredResponse>(candidate))?.keyBase : undefined;
        const base = storedBase ?? (marker >= 0 ? rest.slice(0, marker) : rest).split("|", 1)[0]!;
        if (base === key) return store.delete(candidate);

        const parsed = splitBase(base);
        if (parsed.method === null || parsed.authority === null) return false;
        const path = targetHasQuery ? parsed.path : parsed.path.split("?", 1)[0]!;
        if (`${parsed.method}:${parsed.authority}:${path}` === key || `${parsed.method}:${path}` === key) {
          return store.delete(candidate);
        }
        return false;
      }),
    );
    return deleted.some(Boolean);
  }

  /**
   * Invalidate all cached responses matching a prefix/pattern.
   */
  async function invalidateAll(pattern?: string): Promise<void> {
    await store.clear(prefix + (pattern ?? ""));
  }

  return { cached, wrap, invalidate, invalidateAll };
}
