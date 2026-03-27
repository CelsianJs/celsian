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
}

const DEFAULT_OPTIONS = {
  ttlMs: 60_000,
  methods: ["GET", "HEAD"],
  statusCodes: [200],
  prefix: "rc:",
};

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
  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;

  function defaultKeyGenerator(request: Request): string {
    const url = new URL(request.url);
    return `${request.method}:${url.pathname}${url.search}`;
  }

  function isExcluded(pathname: string): boolean {
    return exclude.some((p) => pathname.startsWith(p));
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

    const cacheKey = prefix + keyGenerator(request);

    // Check cache
    const cached = await store.get<CachedResponse>(cacheKey);
    if (cached) {
      const headers = { ...cached.headers, "x-cache": "HIT" };
      return new Response(method === "HEAD" ? null : cached.body, {
        status: cached.status,
        headers,
      });
    }

    // Execute handler
    const response = await handler();

    // Only cache successful responses
    if (!statusCodes.includes(response.status)) {
      return response;
    }

    // Clone and cache the response
    const body = await response.clone().text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
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
    const newHeaders = new Headers(response.headers);
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
    return store.delete(prefix + key);
  }

  /**
   * Invalidate all cached responses matching a prefix/pattern.
   */
  async function invalidateAll(pattern?: string): Promise<void> {
    await store.clear(prefix + (pattern ?? ""));
  }

  return { cached, wrap, invalidate, invalidateAll };
}
