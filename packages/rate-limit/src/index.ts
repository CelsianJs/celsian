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
  /**
   * Number of trusted reverse proxies between the client and this app. Used to
   * pick the client IP from X-Forwarded-For: the IP is taken this many entries
   * from the RIGHT, because trusted proxies append the address they saw on the
   * right while everything further left is client-supplied (spoofable).
   * Default: 1 (one trusted proxy — e.g. a single nginx / load balancer).
   */
  trustedProxyHops?: number;
  /**
   * Maximum number of distinct keys held by the default in-memory store before
   * eviction kicks in (guards against memory exhaustion from spoofed-key
   * floods). Ignored when a custom `store` is provided. Default: 100_000.
   */
  maxKeys?: number;
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

/** Options for {@link MemoryRateLimitStore}. */
export interface MemoryRateLimitStoreOptions {
  /**
   * Maximum number of distinct keys held at once. When the cap is reached, an
   * expired (or failing that, the oldest) entry is evicted to make room. This
   * bounds memory even when an attacker floods the limiter with spoofed keys.
   * Default: 100_000.
   */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 100_000;

/** In-memory fixed-window store with periodic cleanup and a max-keys cap. Single-process only. */
export class MemoryRateLimitStore implements RateLimitStore {
  private entries = new Map<string, WindowEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxKeys: number;

  constructor(options?: MemoryRateLimitStoreOptions) {
    const maxKeys = options?.maxKeys ?? DEFAULT_MAX_KEYS;
    if (typeof maxKeys !== "number" || !Number.isFinite(maxKeys) || maxKeys < 1) {
      throw new CelsianError(`[@celsian/rate-limit] \`maxKeys\` must be a positive number, got ${String(maxKeys)}.`);
    }
    this.maxKeys = Math.floor(maxKeys);
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

    // New key (or expired window). Enforce the max-keys cap BEFORE inserting a
    // brand-new key so spoofed-key floods (e.g. rotating X-Forwarded-For) can't
    // grow the map without bound and exhaust memory.
    if (!existing && this.entries.size >= this.maxKeys) {
      this.evictOne(now);
    }

    const entry: WindowEntry = {
      count: 1,
      resetAt: now + window,
    };
    // delete-then-set moves refreshed keys to the end of the Map's insertion
    // order, so iteration order approximates "oldest window first" for eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return Promise.resolve({ count: 1, resetAt: entry.resetAt });
  }

  /**
   * Evict one entry to make room: prefer an expired entry from the oldest few,
   * otherwise evict the oldest-inserted entry outright. The scan is bounded so
   * eviction stays O(1) per insert even while an attacker floods fresh keys —
   * an unbounded "find any expired entry" sweep here would be its own DoS.
   */
  private evictOne(now: number): void {
    let scanned = 0;
    let oldest: string | undefined;
    for (const [key, entry] of this.entries) {
      if (oldest === undefined) oldest = key;
      if (entry.resetAt <= now) {
        this.entries.delete(key);
        return;
      }
      if (++scanned >= 8) break;
    }
    if (oldest !== undefined) this.entries.delete(oldest);
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

function createDefaultKeyGenerator(trustProxy: boolean, trustedProxyHops: number): (req: CelsianRequest) => string {
  if (trustProxy) {
    return (req: CelsianRequest): string => {
      const xff = req.headers.get("x-forwarded-for");
      if (xff) {
        // X-Forwarded-For is attacker-controlled EXCEPT for the entries your
        // own trusted proxies append — and proxies append the address they saw
        // on the RIGHT. So the real client IP (as seen by the first trusted
        // proxy) sits `trustedProxyHops` entries from the right. The leftmost
        // value is whatever the client put in the header it sent — keying on
        // it lets an attacker rotate a fake IP per request and fully bypass
        // rate limiting (while flooding the store with unique keys).
        // We never fall back to index 0 unless `trustedProxyHops` covers the
        // entire list (i.e. every entry was appended by a trusted proxy).
        const entries = xff
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        const clientIp = entries[Math.max(0, entries.length - trustedProxyHops)];
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
 * Validate that a numeric option is a positive finite number at registration
 * time. A missing/NaN/non-positive `window` would make every bucket's resetAt
 * NaN — every request would see a "fresh" window and the limiter silently
 * fails OPEN. Fail closed instead (same philosophy as the trustProxy guard).
 */
function assertPositiveNumber(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new CelsianError(
      `[@celsian/rate-limit] \`${name}\` must be a positive number, got ${String(value)}. ` +
        "An invalid value would silently disable rate limiting (fail open), so registration fails instead.",
    );
  }
}

/**
 * Fixed-window rate limiter plugin. Adds `x-ratelimit-*` headers and returns 429 when exceeded.
 *
 * @example
 * ```ts
 * // `trustProxy: true` (or a custom keyGenerator) is required so the limiter
 * // knows how to identify clients behind a proxy — it throws otherwise.
 * await app.register(rateLimit({ max: 100, window: 60_000, trustProxy: true }));
 * ```
 */
export function rateLimit(options: RateLimitOptions): PluginFunction {
  const max = options.max;
  const window = options.window;
  assertPositiveNumber("max", max);
  assertPositiveNumber("window", window);
  const trustProxy = options.trustProxy ?? false;
  const trustedProxyHops = options.trustedProxyHops ?? 1;
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 1) {
    throw new CelsianError(
      `[@celsian/rate-limit] \`trustedProxyHops\` must be an integer >= 1, got ${String(trustedProxyHops)}.`,
    );
  }
  const keyGenerator = options.keyGenerator ?? createDefaultKeyGenerator(trustProxy, trustedProxyHops);
  const store = options.store ?? new MemoryRateLimitStore({ maxKeys: options.maxKeys });

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
