// @celsian/rate-limit — Fixed-window rate limiter with pluggable store

import type { CelsianReply, CelsianRequest, HookHandler, PluginFunction } from "@celsian/core";
import { CelsianError } from "@celsian/core";

/** Options for the rate limiter: max requests, window size, key generation, and store. */
export interface RateLimitOptions {
  max: number;
  window: number;
  keyGenerator?: (req: CelsianRequest) => string;
  store?: RateLimitStore;
  /** Trust X-Forwarded-For / X-Real-IP headers. Default: false */
  trustProxy?: boolean;
}

/**
 * Pluggable store for rate limit counters (implement for Redis, etc.).
 *
 * CONTRACT: `increment` MUST be atomic. Concurrent calls for the same key must
 * never lose updates — if N calls run for a key within one window, the final
 * observed count must reach N. The in-process {@link MemoryRateLimitStore}
 * achieves this by doing the read-modify-write synchronously (no `await` gap).
 * A distributed implementation (e.g. Redis) MUST use an atomic primitive such
 * as `INCR` + `EXPIRE` (ideally in a single Lua script / MULTI) rather than a
 * GET-then-SET, otherwise the limiter can be bypassed under concurrency.
 */
export interface RateLimitStore {
  increment(key: string, window: number): Promise<{ count: number; resetAt: number }>;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

/** In-memory fixed-window store with periodic cleanup. Single-process only. */
export class MemoryRateLimitStore implements RateLimitStore {
  private entries = new Map<string, WindowEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (entry.resetAt <= now) {
          this.entries.delete(key);
        }
      }
    }, 60_000);
    this.cleanupTimer.unref?.();
  }

  increment(key: string, window: number): Promise<{ count: number; resetAt: number }> {
    // The entire read-modify-write below runs SYNCHRONOUSLY within this call:
    // there is no `await` between reading `existing` and writing the updated
    // count, so concurrent increments cannot interleave and lose updates. We
    // compute the result first and only wrap it in a resolved promise at the
    // end to satisfy the async store contract. Do NOT introduce an `await`
    // here or the operation becomes non-atomic.
    const now = Date.now();
    const existing = this.entries.get(key);

    if (existing && existing.resetAt > now) {
      existing.count++;
      return Promise.resolve({ count: existing.count, resetAt: existing.resetAt });
    }

    const entry: WindowEntry = {
      count: 1,
      resetAt: now + window,
    };
    this.entries.set(key, entry);
    return Promise.resolve({ count: 1, resetAt: entry.resetAt });
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

function createDefaultKeyGenerator(trustProxy: boolean): (req: CelsianRequest) => string {
  if (trustProxy) {
    return (req: CelsianRequest): string => {
      const xff = req.headers.get("x-forwarded-for");
      if (xff) {
        // Use the first (leftmost) IP — this is the original client IP.
        // The last IP is the most recent proxy, which an attacker can't spoof,
        // but using the first IP is standard for client identification.
        // If you need to trust only specific proxy hops, use a custom keyGenerator.
        const clientIp = xff.split(",")[0]?.trim();
        if (clientIp) return clientIp;
      }
      // Fail closed: when we cannot identify the client (no XFF / X-Real-IP),
      // bucket all such requests under one shared constant key so they share a
      // single limit. A per-request unique value (e.g. a timestamp) would give
      // every unidentified request its own counter, silently disabling the
      // limiter for anonymous traffic.
      return req.headers.get("x-real-ip") ?? "anonymous";
    };
  }
  throw new CelsianError(
    "[@celsian/rate-limit] trustProxy is false and no custom keyGenerator was provided. " +
      "Rate limiting cannot identify clients without a key. " +
      "Set trustProxy:true (behind a reverse proxy) or provide a custom keyGenerator.",
  );
}

/**
 * Fixed-window rate limiter plugin. Adds `x-ratelimit-*` headers and returns 429 when exceeded.
 *
 * @example
 * ```ts
 * await app.register(rateLimit({ max: 100, window: 60_000 }));
 * ```
 */
export function rateLimit(options: RateLimitOptions): PluginFunction {
  const max = options.max;
  const window = options.window;
  const trustProxy = options.trustProxy ?? false;
  const keyGenerator = options.keyGenerator ?? createDefaultKeyGenerator(trustProxy);
  const store = options.store ?? new MemoryRateLimitStore();

  return function rateLimitPlugin(app) {
    const hook: HookHandler<void | Response> = async (request: CelsianRequest, reply: CelsianReply) => {
      const key = keyGenerator(request);
      const { count, resetAt } = await store.increment(key, window);

      reply.header("x-ratelimit-limit", String(max));
      reply.header("x-ratelimit-remaining", String(Math.max(0, max - count)));
      reply.header("x-ratelimit-reset", String(Math.ceil(resetAt / 1000)));

      if (count > max) {
        const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
        return reply.status(429).header("retry-after", String(retryAfter)).json({
          error: "Too Many Requests",
          statusCode: 429,
          retryAfter,
        });
      }
    };

    app.addHook("onRequest", hook as HookHandler);
  };
}
