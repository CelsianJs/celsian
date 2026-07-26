// @celsian/rate-limit, Redis-backed store for multi-instance deployments

import { CelsianError } from "@celsian/core";
import type { RateLimitStore } from "./index.js";

/**
 * Minimal Redis client surface this store needs.
 *
 * Deliberately structural rather than an `ioredis` import: `@celsian/rate-limit`
 * ships with zero third-party runtime dependencies, so you inject the client
 * your app already owns. An `ioredis` instance satisfies this as-is.
 */
export interface RedisRateLimitClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisRateLimitStoreOptions {
  /** An existing Redis client (e.g. `new Redis(url)` from ioredis). */
  client: RedisRateLimitClient;
  /** Key prefix for all limiter keys (default: `celsian:rl:`). */
  prefix?: string;
}

/**
 * Increment a fixed-window counter and return `{ count, ttlMs }`.
 *
 * The whole read-modify-write happens inside one Lua script, so it is atomic
 * across every instance sharing this Redis. A GET-then-SET from the app would
 * lose updates under concurrency and let the limiter be bypassed, which is
 * exactly what the {@link RateLimitStore} contract forbids.
 *
 * KEYS[1] = counter key, ARGV[1] = window in ms.
 * The TTL is set only when the key is created, so the window is fixed rather
 * than sliding forward on every request.
 */
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

/**
 * Redis-backed fixed-window store. Use this whenever more than one instance
 * serves the app, the in-memory store is per-process, so N instances multiply
 * the effective limit by N.
 *
 * @example
 * ```ts
 * import Redis from 'ioredis';
 * import { rateLimit, createRedisRateLimitStore } from '@celsian/rate-limit';
 *
 * await app.register(rateLimit({
 *   max: 100,
 *   window: 60_000,
 *   store: createRedisRateLimitStore({ client: new Redis(process.env.REDIS_URL!) }),
 *   keyGenerator: (req) => req.user?.sub ?? 'anonymous',
 * }));
 * ```
 */
export function createRedisRateLimitStore(options: RedisRateLimitStoreOptions): RateLimitStore {
  const client = options.client;
  if (!client || typeof client.eval !== "function") {
    throw new CelsianError(
      "[@celsian/rate-limit] `client` must be a Redis client exposing `eval(script, numKeys, ...args)` " +
        "(an ioredis instance satisfies this). The client is injected so this package keeps zero runtime dependencies.",
    );
  }
  const prefix = options.prefix ?? "celsian:rl:";

  return {
    async increment(key: string, window: number): Promise<{ count: number; resetAt: number }> {
      const raw = (await client.eval(INCREMENT_SCRIPT, 1, prefix + key, String(window))) as
        | [number | string, number | string]
        | undefined;

      if (!Array.isArray(raw) || raw.length < 2) {
        throw new CelsianError(
          `[@celsian/rate-limit] Unexpected reply from Redis for key ${key}: ${JSON.stringify(raw)}. ` +
            "The limiter fails closed rather than letting an unreadable reply pass traffic through.",
        );
      }

      const count = Number(raw[0]);
      const ttlMs = Number(raw[1]);
      if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) {
        throw new CelsianError(`[@celsian/rate-limit] Non-numeric reply from Redis for key ${key}.`);
      }

      return { count, resetAt: Date.now() + Math.max(0, ttlMs) };
    },
  };
}
