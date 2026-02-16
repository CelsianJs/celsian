// @celsian/server — Rate limiting middleware plugin

import type { PluginFunction, HookHandler } from '../types.js';
import { fp } from '../types.js';

export interface RateLimitOptions {
  /** Maximum requests per window */
  max?: number;
  /** Time window in milliseconds */
  windowMs?: number;
  /** Key generator — determines what to rate-limit by (default: IP-based) */
  keyGenerator?: (request: Request) => string;
  /** Custom response when rate limited */
  onLimitReached?: (request: Request) => Response;
  /** Include rate limit headers in response */
  headers?: boolean;
  /** Store implementation (default: in-memory) */
  store?: RateLimitStore;
}

export interface RateLimitStore {
  /** Increment the counter for a key, return the new count and remaining TTL */
  increment(key: string): Promise<{ count: number; resetMs: number }>;
  /** Reset the store (for testing) */
  reset?(): void;
}

// ─── In-Memory Store ───

class MemoryStore implements RateLimitStore {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  async increment(key: string): Promise<{ count: number; resetMs: number }> {
    const now = Date.now();
    let entry = this.hits.get(key);

    if (!entry || entry.resetAt <= now) {
      // Window expired or new key — start fresh
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }

    entry.count++;
    return { count: entry.count, resetMs: entry.resetAt - now };
  }

  reset(): void {
    this.hits.clear();
  }
}

// ─── Default Key Generator ───

function defaultKeyGenerator(request: Request): string {
  // Try common proxy headers first
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;

  // Fallback to a generic key (in serverless environments, IP isn't always available)
  return 'global';
}

/**
 * Rate limiting middleware plugin.
 *
 * Usage:
 * ```ts
 * app.register(rateLimit, { max: 100, windowMs: 60_000 });
 * ```
 */
export const rateLimit: PluginFunction = fp(async (app, options) => {
  const max = (options as RateLimitOptions).max ?? 100;
  const windowMs = (options as RateLimitOptions).windowMs ?? 60_000;
  const keyGenerator = (options as RateLimitOptions).keyGenerator ?? defaultKeyGenerator;
  const includeHeaders = (options as RateLimitOptions).headers !== false;
  const onLimitReached = (options as RateLimitOptions).onLimitReached;
  const store = (options as RateLimitOptions).store ?? new MemoryStore(windowMs);

  const rateLimitHook: HookHandler = async (request, reply) => {
    const key = keyGenerator(request);
    const { count, resetMs } = await store.increment(key);
    const remaining = Math.max(0, max - count);

    if (includeHeaders) {
      reply.header('x-ratelimit-limit', String(max));
      reply.header('x-ratelimit-remaining', String(remaining));
      reply.header('x-ratelimit-reset', String(Math.ceil(resetMs / 1000)));
    }

    if (count > max) {
      if (onLimitReached) {
        return onLimitReached(request);
      }

      if (includeHeaders) {
        reply.header('retry-after', String(Math.ceil(resetMs / 1000)));
      }

      return reply.status(429).json({
        error: 'Too Many Requests',
        statusCode: 429,
        retryAfter: Math.ceil(resetMs / 1000),
      });
    }
  };

  app.addHook('onRequest', rateLimitHook);
});

export { MemoryStore };
