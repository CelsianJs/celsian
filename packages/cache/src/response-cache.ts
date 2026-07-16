// @celsian/cache — HTTP response caching

import type { KVStore } from "./store.js";

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  cachedAt: number;
}

export interface ResponseCacheOptions {
  /** KV store to use for caching */
  store: KVStore;
  /** Default TTL in milliseconds (default: 60_000) */
  ttlMs?: number;
  /** Cache key generator. Default: `${method}:${pathname}` */
  keyGenerator?: (request: Request) => string;
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
}

const DEFAULT_OPTIONS = {
  ttlMs: 60_000,
  methods: ["GET", "HEAD"],
  statusCodes: [200],
  prefix: "rc:",
};

/**
 * Denylist of per-user / credential-bearing headers that MUST NOT be cached.
 *
 * A response cache replays a single stored response to many users, so any
 * header carrying a user's identity or credentials would leak to everyone
 * hitting the cache. We deny exactly those headers and preserve everything
 * else — representation headers (`content-type`, `etag`, ...), CORS headers,
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

const DEFAULT_CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const PRIVATE_RESPONSE_HEADERS = ["set-cookie", "set-cookie2", "authorization", "proxy-authorization"];
// `no-cache` permits storage only when every reuse is revalidated. This cache
// has no validator/revalidation path, so storing it would turn the next request
// into an invalid HIT. Fail closed and call the origin handler every time.
const SHARED_CACHE_PROHIBITED_DIRECTIVES = new Set(["private", "no-store", "no-cache"]);
const REQUEST_CACHE_BYPASS_DIRECTIVES = new Set(["no-store", "no-cache"]);
const REQUEST_NO_STORE_DIRECTIVE = new Set(["no-store"]);

function hasDirective(value: string | null, directives: Set<string>): boolean {
  if (!value) return false;

  return value.split(",").some((part) => {
    const directive = part.trim().toLowerCase().split("=", 1)[0]?.trim();
    return directive ? directives.has(directive) : false;
  });
}

function hasZeroMaxAge(value: string | null): boolean {
  if (!value) return false;

  return value.split(",").some((part) => {
    const [rawName, ...rawValueParts] = part.split("=");
    const name = rawName?.trim().toLowerCase();
    if (name !== "max-age" && name !== "s-maxage") return false;

    const rawValue = rawValueParts.join("=").trim();
    const valueWithoutQuotes = rawValue.replace(/^"|"$/g, "");
    return /^0+$/.test(valueWithoutQuotes);
  });
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
  const representedVaryHeaders = new Set(["origin", ...varyHeaders.map((header) => header.toLowerCase())]);
  const credentialHeaders = new Set(
    [...DEFAULT_CREDENTIAL_HEADERS, ...(options.credentialHeaders ?? [])].map((header) => header.toLowerCase()),
  );
  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;

  function defaultKeyGenerator(request: Request): string {
    const url = new URL(request.url);
    return `${request.method}:${url.pathname}${url.search}`;
  }

  function cacheKeyForRequest(request: Request): string {
    let key = prefix + keyGenerator(request);
    // Reflected CORS responses carry `Vary: Origin`, but the response is not
    // available when the lookup key is created. Partition Origin eagerly so
    // neither the body nor Access-Control-Allow-Origin can cross origins. The
    // absent-origin suffix also prevents a pre-upgrade unpartitioned entry from
    // being reused after this safety boundary is introduced.
    for (const header of representedVaryHeaders) {
      key += `|${header}=${encodeURIComponent(request.headers.get(header) ?? "")}`;
    }
    return key;
  }

  function isExcluded(pathname: string): boolean {
    return exclude.some((p) => pathname.startsWith(p));
  }

  function hasCredentials(request: Request): boolean {
    for (const header of credentialHeaders) {
      if (request.headers.has(header)) return true;
    }
    return false;
  }

  function canStoreSharedResponse(response: Response): boolean {
    const cacheControl = response.headers.get("cache-control");
    if (hasDirective(cacheControl, SHARED_CACHE_PROHIBITED_DIRECTIVES) || hasZeroMaxAge(cacheControl)) {
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
    if (hasWildcardVary(cached.headers.vary ?? null)) {
      return false;
    }
    if (parseVary(cached.headers.vary ?? null).some((header) => !representedVaryHeaders.has(header))) {
      return false;
    }
    return !PRIVATE_RESPONSE_HEADERS.some((header) => header in cached.headers);
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

    // This is a shared response cache. Credentialed requests must bypass both
    // reads and writes so a public entry cannot mask a personalized response
    // and a personalized response cannot populate the public cache.
    if (hasCredentials(request)) {
      return handler();
    }

    const requestCacheControl = request.headers.get("cache-control");
    const requestNoStore = hasDirective(requestCacheControl, REQUEST_NO_STORE_DIRECTIVE);
    const bypassRead =
      hasDirective(requestCacheControl, REQUEST_CACHE_BYPASS_DIRECTIVES) ||
      hasZeroMaxAge(requestCacheControl) ||
      request.headers
        .get("pragma")
        ?.toLowerCase()
        .split(",")
        .some((value) => value.trim() === "no-cache") === true;

    if (requestNoStore) {
      return handler();
    }

    const url = new URL(request.url);
    if (isExcluded(url.pathname)) {
      return handler();
    }

    const cacheKey = cacheKeyForRequest(request);

    // Check cache
    const cached = bypassRead ? undefined : await store.get<CachedResponse>(cacheKey);
    if (cached) {
      // Defend against entries written by an older release that stored a
      // response requiring revalidation. Never promote such an entry to HIT.
      if (!canReplaySharedResponse(cached)) {
        await store.delete(cacheKey);
      } else {
        const headers = { ...cached.headers, "x-cache": "HIT" };
        return new Response(method === "HEAD" ? null : cached.body, {
          status: cached.status,
          headers,
        });
      }
    }

    // Execute handler
    const response = await handler();

    // Only cache successful responses
    if (!statusCodes.includes(response.status)) {
      return response;
    }

    // Respect response-side shared-cache prohibitions before cloning the body.
    // Stripping Set-Cookie or Authorization alone is insufficient because the
    // personalized response body could still be replayed to another user.
    if (!canStoreSharedResponse(response)) {
      return response;
    }

    // Clone and cache the response
    const body = await response.clone().text();
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

    await store.set<CachedResponse>(
      cacheKey,
      {
        status: response.status,
        headers: responseHeaders,
        body,
        cachedAt: Date.now(),
      },
      customTtlMs ?? ttlMs,
    );

    // Add cache miss header
    const newHeaders = new Headers(replayHeaders);
    newHeaders.set("x-cache", "MISS");

    return new Response(body, {
      status: response.status,
      headers: newHeaders,
    });
  }

  /**
   * Wrap a fetch-compatible handler with caching.
   */
  function wrap(handler: (request: Request) => Response | Promise<Response>): (request: Request) => Promise<Response> {
    return (request: Request) => cached(request, () => handler(request));
  }

  /**
   * Invalidate a specific cache key.
   */
  async function invalidate(key: string): Promise<boolean> {
    const baseKey = prefix + key;
    const keys = await store.keys();
    const matches = keys.filter((candidate) => candidate === baseKey || candidate.startsWith(`${baseKey}|origin=`));
    const deleted = await Promise.all(matches.map((candidate) => store.delete(candidate)));
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
