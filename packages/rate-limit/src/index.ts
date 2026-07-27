// @celsian/rate-limit, Fixed-window rate limiter with pluggable store

import type { CelsianReply, CelsianRequest, HookHandler, PluginFunction } from "@celsian/core";
import { CelsianError } from "@celsian/core";
import { sha256Hex } from "./hash.js";
import { type Cidr, canonicalizeIp, isTrustedProxy, parseCidr } from "./ip.js";

export type { Cidr, ParsedIp } from "./ip.js";
export { canonicalizeIp, formatIp, ipInCidr, isTrustedProxy, parseCidr, parseIp } from "./ip.js";
export { createRedisRateLimitStore, type RedisRateLimitClient, type RedisRateLimitStoreOptions } from "./redis.js";

/** Options for the rate limiter: max requests, window size, key generation, and store. */
export interface RateLimitOptions {
  max: number;
  window: number;
  /**
   * How to bucket requests. THE RECOMMENDED CHOICE: key on an authenticated
   * user / API key id, which is not attacker-controlled. Proxy-header keying is
   * only as trustworthy as the trust boundary you declare below.
   */
  keyGenerator?: (req: CelsianRequest) => string;
  store?: RateLimitStore;
  /**
   * Declare the reverse proxies in front of this app, as IPs or CIDR blocks
   * (e.g. `['10.0.0.0/8', '2001:db8::/32']`). The client IP is then the
   * rightmost `X-Forwarded-For` entry that is NOT one of these, the standard
   * untrusted-hop algorithm. This is the safe way to key on a proxy header:
   * every value to the left of your own proxies is client-supplied and
   * spoofable, and this is the only option that actually verifies which entries
   * your infrastructure appended.
   */
  trustedProxies?: string[];
  /**
   * ADVANCED / legacy hop-count mode. Trust `X-Forwarded-For` and take the IP
   * `trustedProxyHops` entries from the right, without verifying that a trusted
   * proxy appended it. Correct only when the hop count is fixed and every
   * request genuinely traverses your proxies. Prefer `trustedProxies`, or a
   * `keyGenerator` keyed on an authenticated identity. Default: false.
   */
  trustProxy?: boolean;
  /**
   * Number of trusted reverse proxies between the client and this app, used by
   * the `trustProxy` hop-count mode. The IP is taken this many entries from the
   * RIGHT, because trusted proxies append the address they saw on the right
   * while everything further left is client-supplied (spoofable). Default: 1.
   *
   * A request arriving with FEWER than `trustedProxyHops` entries did not
   * traverse the declared proxies, so the limiter fails closed and puts it in
   * the shared unidentified bucket. It does NOT fall back to the leftmost
   * entry, which is client-supplied and would hand the caller its own key.
   */
  trustedProxyHops?: number;
  /**
   * Consult `X-Real-IP` when `X-Forwarded-For` yields no client address.
   * Default: FALSE. This header is a single unhopped value that the client
   * fully controls unless a proxy overwrites it, so as a silent fallback it
   * both let an attacker mint a fresh bucket per request AND let them burn a
   * victim's bucket by setting it to the victim's IP (targeted lockout, e.g.
   * on `/login`). Enable it only when a proxy you control always overwrites it.
   */
  trustXRealIp?: boolean;
  /**
   * Maximum number of distinct keys held by the default in-memory store before
   * eviction kicks in (guards against memory exhaustion from spoofed-key
   * floods). Ignored when a custom `store` is provided. Default: 100_000.
   */
  maxKeys?: number;
  /**
   * Maximum key length in characters. Longer keys are replaced by a SHA-256
   * digest of themselves rather than stored verbatim, which bounds memory
   * without merging unrelated clients into a shared bucket. Default: 256.
   */
  maxKeyLength?: number;
}

/**
 * Pluggable store for rate limit counters (implement for Redis, etc.).
 *
 * CONTRACT: `increment` MUST be atomic. Concurrent calls for the same key must
 * never lose updates, if N calls run for a key within one window, the final
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
   * expired entry, or failing that, the LEAST-established entry, is evicted
   * to make room. This bounds memory even when an attacker floods the limiter
   * with spoofed keys. Default: 100_000.
   */
  maxKeys?: number;
  /** Called (once per store) the first time the key cap forces an eviction. */
  onCapReached?: (maxKeys: number) => void;
}

const DEFAULT_MAX_KEYS = 100_000;
const DEFAULT_MAX_KEY_LENGTH = 256;
/**
 * Prefix for the digest of an over-long key. Over-long keys used to be
 * collapsed into ONE shared bucket, which bounded memory but merged unrelated
 * clients: a `keyGenerator` legitimately returning long keys (a composite
 * tenant+user key, a long token subject) made user B inherit user A's count and
 * get a 429 on their very first request.
 *
 * Hashing bounds the stored key just as hard while keeping distinct clients
 * distinct. The digest is cryptographic ({@link sha256Hex}) precisely because
 * the earlier objection to hashing was collision-onto-a-victim: with SHA-256
 * that requires a second preimage, not a birthday search. The prefix keeps the
 * digest out of the namespace a `keyGenerator` could plausibly produce
 * verbatim, so a hashed key cannot land on an unhashed one.
 */
const HASHED_KEY_PREFIX = "__hashed__:";
const EVICTION_SCAN_LIMIT = 16;

/** In-memory fixed-window store with periodic cleanup and a max-keys cap. Single-process only. */
export class MemoryRateLimitStore implements RateLimitStore {
  private entries = new Map<string, WindowEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxKeys: number;
  private readonly onCapReached: ((maxKeys: number) => void) | undefined;
  private capWarned = false;

  constructor(options?: MemoryRateLimitStoreOptions) {
    const maxKeys = options?.maxKeys ?? DEFAULT_MAX_KEYS;
    if (typeof maxKeys !== "number" || !Number.isFinite(maxKeys) || maxKeys < 1) {
      throw new CelsianError(`[@celsian/rate-limit] \`maxKeys\` must be a positive number, got ${String(maxKeys)}.`);
    }
    this.maxKeys = Math.floor(maxKeys);
    this.onCapReached = options?.onCapReached;
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
      if (!this.capWarned) {
        this.capWarned = true;
        (
          this.onCapReached ??
          ((cap: number) =>
            console.warn(
              `[@celsian/rate-limit] The in-memory store hit its ${cap}-key cap and is now evicting entries. ` +
                "This usually means the limiter is keyed on an attacker-controlled value. Key on an " +
                "authenticated user id via `keyGenerator`, or declare `trustedProxies`.",
            ))
        )(this.maxKeys);
      }
    }

    const entry: WindowEntry = { count: 1, resetAt: now + window };
    this.entries.delete(key);
    this.entries.set(key, entry);
    return Promise.resolve({ count: 1, resetAt: entry.resetAt });
  }

  /**
   * Evict one entry to make room. Prefer an expired entry; otherwise evict the
   * LEAST-ESTABLISHED live entry, lowest count, tie-broken by soonest reset.
   *
   * Insertion-order eviction was itself the attack: a flood of fresh keys is
   * always "newest", so the victim being throttled was always the one evicted,
   * and their counter reset. Count-ordered eviction discards the flood's own
   * count-1 entries instead, which is exactly what you want to drop. The scan
   * is bounded so eviction stays O(1) per insert, an unbounded sweep here
   * would be its own DoS.
   */
  private evictOne(now: number): void {
    let scanned = 0;
    let weakest: string | undefined;
    let weakestEntry: WindowEntry | undefined;

    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
        return;
      }
      if (
        weakestEntry === undefined ||
        entry.count < weakestEntry.count ||
        (entry.count === weakestEntry.count && entry.resetAt < weakestEntry.resetAt)
      ) {
        weakest = key;
        weakestEntry = entry;
      }
      if (++scanned >= EVICTION_SCAN_LIMIT) break;
    }

    if (weakest !== undefined) this.entries.delete(weakest);
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/** Shared bucket for requests whose client cannot be identified. */
const ANONYMOUS_KEY = "anonymous";

function splitForwardedFor(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Client IP from the rightmost X-Forwarded-For entry that is NOT one of our own
 * proxies. Everything to the left of the first untrusted hop is client-supplied.
 */
function clientIpFromTrustedProxies(req: CelsianRequest, trusted: Cidr[]): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const entries = splitForwardedFor(xff);
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i]!;
    // `canonicalizeIp` returns null for text that is not an address at all.
    // That entry is client-supplied, so we fail closed rather than key on the
    // raw text, which would be a rotatable, unbounded bucket key.
    if (!isTrustedProxy(candidate, trusted)) return canonicalizeIp(candidate);
  }
  // Every entry was one of our proxies, there is no client address to key on.
  return null;
}

function clientIpFromHopCount(req: CelsianRequest, hops: number): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const entries = splitForwardedFor(xff);
  // Trusted proxies append the address they saw on the RIGHT, so the real
  // client IP sits `hops` entries from the right. Keying on the LEFTMOST value
  // lets an attacker rotate a fake IP per request and fully bypass the limiter.
  //
  // FAIL CLOSED when the chain is SHORTER than the declared hop count. This
  // used to clamp the index to 0, which is the worst possible fallback: with
  // fewer real hops than configured, index 0 is a fully client-supplied entry,
  // handing the attacker their own bucket key. That was both an unlimited-quota
  // bypass (rotate the value, get a fresh bucket every request) and a targeted
  // lockout primitive (set it to a victim's IP and burn the victim's bucket
  // before they ever send a request). A chain this short means the request did
  // NOT traverse the declared proxies, so there is nothing here to trust: drop
  // to the shared unidentified bucket instead.
  if (entries.length < hops) return null;
  return canonicalizeIp(entries[entries.length - hops]!);
}

function createDefaultKeyGenerator(options: {
  trustedProxies: Cidr[] | null;
  trustProxy: boolean;
  trustedProxyHops: number;
  trustXRealIp: boolean;
}): (req: CelsianRequest) => string {
  const { trustedProxies, trustProxy, trustedProxyHops, trustXRealIp } = options;

  if (!trustedProxies && !trustProxy) {
    throw new CelsianError(
      "[@celsian/rate-limit] No way to identify clients. Rate limiting needs a key. In order of preference: " +
        "(1) pass a `keyGenerator` keyed on an authenticated user or API-key id, attacker-controlled headers are not " +
        "a trust boundary; (2) declare `trustedProxies: ['10.0.0.0/8', ...]` so the client IP is the rightmost " +
        "X-Forwarded-For entry that is not one of your proxies; (3) as a last resort set `trustProxy: true` with a " +
        "fixed `trustedProxyHops`. Registration fails rather than silently rate limiting nothing.",
    );
  }

  return (req: CelsianRequest): string => {
    const fromXff = trustedProxies
      ? clientIpFromTrustedProxies(req, trustedProxies)
      : clientIpFromHopCount(req, trustedProxyHops);
    if (fromXff) return fromXff;

    // X-Real-IP is a single unhopped value. Consulting it silently handed the
    // client control of its own bucket key (and of a victim's). Only when the
    // deployment explicitly declares a proxy overwrites it.
    if (trustXRealIp) {
      const realIp = req.headers.get("x-real-ip");
      // Canonicalized like the XFF path: one host is one bucket regardless of
      // spelling, and unparseable text falls through to the shared bucket
      // instead of becoming a rotatable key.
      const canonical = realIp ? canonicalizeIp(realIp) : null;
      if (canonical) return canonical;
    }

    // Fail closed: when we cannot identify the client, bucket all such requests
    // under one shared key so they share a single limit. A per-request unique
    // value would give every unidentified request its own counter, silently
    // disabling the limiter for anonymous traffic.
    return ANONYMOUS_KEY;
  };
}

/**
 * Validate that a numeric option is a positive finite number at registration
 * time. A missing/NaN/non-positive `window` would make every bucket's resetAt
 * NaN, every request would see a "fresh" window and the limiter silently
 * fails OPEN. Fail closed instead.
 */
function assertPositiveNumber(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new CelsianError(
      `[@celsian/rate-limit] \`${name}\` must be a positive number, got ${String(value)}. ` +
        "An invalid value would silently disable rate limiting (fail open), so registration fails instead.",
    );
  }
}

function parseTrustedProxies(values: string[] | undefined): Cidr[] | null {
  if (values === undefined) return null;
  if (!Array.isArray(values) || values.length === 0) {
    throw new CelsianError(
      "[@celsian/rate-limit] `trustedProxies` must be a non-empty array of IPs or CIDR blocks. " +
        "An empty list declares no trust boundary, which would key on a fully client-controlled value.",
    );
  }
  return values.map((value) => {
    const cidr = parseCidr(value);
    if (!cidr) {
      throw new CelsianError(
        `[@celsian/rate-limit] \`trustedProxies\` entry is not a valid IP or CIDR block: ${String(value)}`,
      );
    }
    return cidr;
  });
}

/**
 * FIXED-WINDOW rate limiter plugin. Adds `x-ratelimit-*` headers and returns 429
 * when exceeded.
 *
 * A fixed window resets all at once, so a client can send `max` requests at the
 * end of one window and `max` more at the start of the next, up to 2x `max`
 * across a window boundary. Size the window accordingly.
 *
 * @example
 * ```ts
 * // Best: key on an authenticated identity, which the client cannot forge.
 * await app.register(rateLimit({
 *   max: 100,
 *   window: 60_000,
 *   keyGenerator: (req) => req.user?.sub ?? 'anonymous',
 * }));
 *
 * // Behind your own proxies: declare them, and the client IP is verified.
 * await app.register(rateLimit({ max: 100, window: 60_000, trustedProxies: ['10.0.0.0/8'] }));
 * ```
 */
export function rateLimit(options: RateLimitOptions): PluginFunction {
  const max = options.max;
  const window = options.window;
  assertPositiveNumber("max", max);
  assertPositiveNumber("window", window);

  const trustedProxies = parseTrustedProxies(options.trustedProxies);
  const trustProxy = options.trustProxy ?? false;
  const trustedProxyHops = options.trustedProxyHops ?? 1;
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 1) {
    throw new CelsianError(
      `[@celsian/rate-limit] \`trustedProxyHops\` must be an integer >= 1, got ${String(trustedProxyHops)}.`,
    );
  }

  const maxKeyLength = options.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH;
  if (!Number.isInteger(maxKeyLength) || maxKeyLength < 1) {
    throw new CelsianError(
      `[@celsian/rate-limit] \`maxKeyLength\` must be an integer >= 1, got ${String(maxKeyLength)}.`,
    );
  }

  const keyGenerator =
    options.keyGenerator ??
    createDefaultKeyGenerator({
      trustedProxies,
      trustProxy,
      trustedProxyHops,
      trustXRealIp: options.trustXRealIp ?? false,
    });
  const store = options.store ?? new MemoryRateLimitStore({ maxKeys: options.maxKeys });

  return function rateLimitPlugin(app) {
    const hook: HookHandler<void | Response> = async (request: CelsianRequest, reply: CelsianReply) => {
      const rawKey = keyGenerator(request);
      // Keys can be attacker-influenced AND unbounded in length: a 20 KB value
      // stored verbatim against a 100k-key cap is gigabytes of retained memory
      // per window. Hash rather than truncate or collapse, so the stored key is
      // bounded to a fixed size without merging unrelated clients into one
      // bucket (truncation would merge every key sharing a prefix; a single
      // shared oversized bucket merged all of them).
      const key = rawKey.length > maxKeyLength ? HASHED_KEY_PREFIX + sha256Hex(rawKey) : rawKey;

      const { count, resetAt } = await store.increment(key, window);

      reply.header("x-ratelimit-limit", String(max));
      reply.header("x-ratelimit-remaining", String(Math.max(0, max - count)));
      reply.header("x-ratelimit-reset", String(Math.ceil(resetAt / 1000)));

      if (count > max) {
        // Never emit `Retry-After: 0`, a well-behaved client would retry
        // immediately, which is the opposite of what a 429 asks for.
        const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
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
