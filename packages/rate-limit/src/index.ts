// @celsian/rate-limit — Fixed-window rate limiter with pluggable store

import type { CelsianReply, CelsianRequest, HookHandler, PluginFunction } from "@celsian/core";

/** Options for the rate limiter: max requests, window size, key generation, and store. */
export interface RateLimitOptions {
  max: number;
  window: number;
  keyGenerator?: (req: CelsianRequest) => string;
  store?: RateLimitStore;
  /** Trust X-Forwarded-For / X-Real-IP headers. Default: false */
  trustProxy?: boolean;
}

/** Pluggable store for rate limit counters (implement for Redis, etc.). */
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
  }

  async increment(key: string, window: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const existing = this.entries.get(key);

    if (existing && existing.resetAt > now) {
      existing.count++;
      return { count: existing.count, resetAt: existing.resetAt };
    }

    const entry: WindowEntry = {
      count: 1,
      resetAt: now + window,
    };
    this.entries.set(key, entry);
    return { count: 1, resetAt: entry.resetAt };
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

let warnedNoKey = false;

function createDefaultKeyGenerator(trustProxy: boolean): (req: CelsianRequest) => string {
  if (trustProxy) {
    return (req: CelsianRequest): string => {
      return (
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        req.headers.get("x-real-ip") ??
        `anonymous-${Date.now().toString(36)}`
      );
    };
  }
  // Without trustProxy and no custom keyGenerator, every request gets a unique key,
  // effectively disabling rate limiting. Warn developers once.
  return (_req: CelsianRequest): string => {
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.warn(
        "[@celsian/rate-limit] WARNING: trustProxy is false and no custom keyGenerator was provided. " +
          "Each request gets a unique key, so rate limiting is effectively disabled. " +
          "Set trustProxy:true (behind a reverse proxy) or provide a custom keyGenerator.",
      );
    }
    return `anonymous-${Date.now().toString(36)}`;
  };
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
