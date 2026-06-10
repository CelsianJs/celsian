import { CelsianError, createApp } from "@celsian/core";
import { describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, rateLimit } from "../src/index.js";

describe("@celsian/rate-limit", () => {
  it("should allow requests within limit", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 5,
        window: 60_000,
        keyGenerator: () => "test-key",
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/api" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBe("5");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("4");
  });

  it("should block requests exceeding limit", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 3,
        window: 60_000,
        keyGenerator: () => "test-key",
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    // 3 requests should be fine
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({ url: "/api" });
      expect(response.status).toBe(200);
    }

    // 4th should be blocked
    const response = await app.inject({ url: "/api" });
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe("Too Many Requests");
  });

  it("should set rate limit headers", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 10,
        window: 60_000,
        keyGenerator: () => "test-key",
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    const r1 = await app.inject({ url: "/api" });
    expect(r1.headers.get("x-ratelimit-limit")).toBe("10");
    expect(r1.headers.get("x-ratelimit-remaining")).toBe("9");
    expect(r1.headers.get("x-ratelimit-reset")).toBeTruthy();

    const r2 = await app.inject({ url: "/api" });
    expect(r2.headers.get("x-ratelimit-remaining")).toBe("8");
  });

  it("should use custom key generator", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 2,
        window: 60_000,
        keyGenerator: (req) => req.headers.get("x-api-key") ?? "unknown",
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    // Different keys should have separate counters
    const r1 = await app.inject({ url: "/api", headers: { "x-api-key": "key-a" } });
    expect(r1.status).toBe(200);

    const r2 = await app.inject({ url: "/api", headers: { "x-api-key": "key-b" } });
    expect(r2.status).toBe(200);

    const r3 = await app.inject({ url: "/api", headers: { "x-api-key": "key-a" } });
    expect(r3.status).toBe(200);

    // Third request from key-a should be blocked
    const r4 = await app.inject({ url: "/api", headers: { "x-api-key": "key-a" } });
    expect(r4.status).toBe(429);
  });

  it("should include retry-after on 429", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 1,
        window: 60_000,
        keyGenerator: () => "test",
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    await app.inject({ url: "/api" });
    const blocked = await app.inject({ url: "/api" });

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("should NOT affect routes outside scope when encapsulated (default)", async () => {
    const app = createApp();

    // Register rate-limit without encapsulate: false
    await app.register(
      rateLimit({
        max: 2,
        window: 60_000,
        keyGenerator: () => "test-key",
      }),
    );

    // Route on the root context -- should NOT be rate-limited because
    // the rate-limit onRequest hook is scoped to the child context
    app.get("/health", (_req, reply) => reply.json({ ok: true }));

    const r1 = await app.inject({ url: "/health" });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-ratelimit-limit")).toBeNull();

    const r2 = await app.inject({ url: "/health" });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("x-ratelimit-limit")).toBeNull();

    const r3 = await app.inject({ url: "/health" });
    expect(r3.status).toBe(200);
    // No rate-limit headers -- the onRequest hook is scoped
    expect(r3.headers.get("x-ratelimit-limit")).toBeNull();
  });
});

describe("MemoryRateLimitStore", () => {
  it("should increment within window", async () => {
    const store = new MemoryRateLimitStore();
    const r1 = await store.increment("key", 60_000);
    expect(r1.count).toBe(1);

    const r2 = await store.increment("key", 60_000);
    expect(r2.count).toBe(2);

    store.destroy();
  });

  it("should reset after window expires", async () => {
    const store = new MemoryRateLimitStore();
    const _r1 = await store.increment("key", 1); // 1ms window

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 10));

    const r2 = await store.increment("key", 60_000);
    expect(r2.count).toBe(1); // Reset

    store.destroy();
  });

  it("increments atomically under concurrency (no lost updates)", async () => {
    const store = new MemoryRateLimitStore();
    const N = 1000;

    // Fire many concurrent increments for the same key. An atomic store must
    // reach exactly N with no lost updates from interleaved read-modify-write.
    const results = await Promise.all(Array.from({ length: N }, () => store.increment("hot-key", 60_000)));

    const maxCount = Math.max(...results.map((r) => r.count));
    expect(maxCount).toBe(N);
    // Counts must be unique 1..N (every increment observed a distinct value).
    expect(new Set(results.map((r) => r.count)).size).toBe(N);

    store.destroy();
  });

  it("enforces the maxKeys cap (spoofed-key floods cannot grow the store unboundedly)", async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 3 });

    await store.increment("k1", 60_000);
    await store.increment("k2", 60_000);
    await store.increment("k3", 60_000);
    await store.increment("k2", 60_000); // k2 → count 2

    // 4th distinct key exceeds the cap → the oldest entry (k1) is evicted.
    await store.increment("k4", 60_000);

    // A surviving key kept its count (k2 → 3; existing-key increments don't evict).
    const r2 = await store.increment("k2", 60_000);
    expect(r2.count).toBe(3);

    // k1 was evicted: incrementing it starts a fresh bucket (count 1).
    // (This insert itself evicts the then-oldest key — the cap holds at 3.)
    const r1 = await store.increment("k1", 60_000);
    expect(r1.count).toBe(1);

    store.destroy();
  });

  it("evicts expired entries before live ones when at the maxKeys cap", async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 3 });

    await store.increment("expired-key", 1); // 1ms window
    await store.increment("live-a", 60_000);
    await store.increment("live-b", 60_000);
    await store.increment("live-b", 60_000); // live-b → count 2

    await new Promise((r) => setTimeout(r, 10)); // let expired-key expire

    // At cap: the expired entry is evicted, not the live ones.
    await store.increment("new-key", 60_000);

    const a = await store.increment("live-a", 60_000);
    expect(a.count).toBe(2); // survived

    const b = await store.increment("live-b", 60_000);
    expect(b.count).toBe(3); // survived

    store.destroy();
  });

  it("throws CelsianError for invalid maxKeys", () => {
    expect(() => new MemoryRateLimitStore({ maxKeys: 0 })).toThrow(CelsianError);
    expect(() => new MemoryRateLimitStore({ maxKeys: Number.NaN })).toThrow(CelsianError);
  });

  it("should call unref on cleanup timer", () => {
    const unrefSpy = vi.fn();
    const originalSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((...args) => {
      const timer = originalSetInterval(...args);
      timer.unref = unrefSpy;
      return timer;
    });

    const store = new MemoryRateLimitStore();
    expect(unrefSpy).toHaveBeenCalledTimes(1);
    store.destroy();

    vi.restoreAllMocks();
  });
});

describe("rate-limit XFF key generation", () => {
  it("keys by the rightmost X-Forwarded-For entry (appended by the trusted proxy) by default", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 2,
        window: 60_000,
        trustProxy: true,
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    // With trustedProxyHops=1 (default), the LAST entry is what the single
    // trusted proxy appended — the real client IP "10.0.0.1".
    const r1 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "spoofed-a, 10.0.0.1" },
    });
    expect(r1.status).toBe(200);

    const r2 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "spoofed-b, 10.0.0.1" },
    });
    expect(r2.status).toBe(200);

    // Third request from same real client IP should be blocked
    const r3 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "spoofed-c, 10.0.0.1" },
    });
    expect(r3.status).toBe(429);

    // Different real client IP should NOT be blocked
    const r4 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "spoofed-a, 192.168.1.1" },
    });
    expect(r4.status).toBe(200);
  });

  it("SECURITY regression: rotating leftmost XFF values cannot bypass the limit", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 3,
        window: 60_000,
        trustProxy: true,
        trustedProxyHops: 1,
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    // Attacker sends a unique fake IP on the LEFT of every request, but the
    // trusted proxy always appends the real client IP on the RIGHT. Before the
    // fix, the leftmost value was keyed → every request got a fresh bucket and
    // the limiter was fully bypassed.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        url: "/api",
        headers: { "x-forwarded-for": `1.2.3.${i}, fake-${i}, 203.0.113.7` },
      });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 200).length).toBe(3);
    expect(statuses.filter((s) => s === 429).length).toBe(7);
  });

  it("respects trustedProxyHops > 1 (keys N entries from the right)", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 1,
        window: 60_000,
        trustProxy: true,
        trustedProxyHops: 2,
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    // Two trusted proxies: the client IP is the second entry from the right.
    const r1 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "spoofed, 10.0.0.9, proxy-inner" },
    });
    expect(r1.status).toBe(200);

    // Same client IP (second from right) → limited, even though the leftmost differs.
    const r2 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "other-spoof, 10.0.0.9, proxy-inner" },
    });
    expect(r2.status).toBe(429);

    // Different client IP (second from right) → separate bucket.
    const r3 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "spoofed, 10.0.0.10, proxy-inner" },
    });
    expect(r3.status).toBe(200);
  });

  it("clamps to the leftmost entry when trustedProxyHops covers the whole list", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 1,
        window: 60_000,
        trustProxy: true,
        trustedProxyHops: 5,
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    // Only 2 entries but 5 trusted hops: every entry was appended by a trusted
    // proxy, so index clamps to 0 (the true client as seen by the outermost proxy).
    const r1 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "10.0.0.1, proxy-inner" },
    });
    expect(r1.status).toBe(200);

    const r2 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "10.0.0.1, proxy-inner" },
    });
    expect(r2.status).toBe(429);
  });

  it("throws CelsianError for invalid trustedProxyHops", () => {
    expect(() => rateLimit({ max: 10, window: 60_000, trustProxy: true, trustedProxyHops: 0 })).toThrow(CelsianError);
    expect(() => rateLimit({ max: 10, window: 60_000, trustProxy: true, trustedProxyHops: 1.5 })).toThrow(CelsianError);
  });

  it("fails closed: unidentified clients (trustProxy, no proxy headers) share one bucket", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 2,
        window: 60_000,
        trustProxy: true,
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      // No x-forwarded-for / x-real-ip — all requests are unidentified.
      const res = await app.inject({ url: "/api" });
      statuses.push(res.status);
    }

    // First 2 pass, the rest are limited (they all share the "anonymous" bucket).
    expect(statuses.filter((s) => s === 200).length).toBe(2);
    expect(statuses.filter((s) => s === 429).length).toBe(8);
  });

  it("fails closed: throws CelsianError when `window` is missing/NaN/non-positive", () => {
    // A NaN/undefined window makes resetAt NaN → every request sees a "fresh"
    // bucket and the limiter silently fails OPEN. Must throw at registration.
    expect(() => rateLimit({ max: 10, window: undefined as unknown as number, keyGenerator: () => "k" })).toThrow(
      CelsianError,
    );
    expect(() => rateLimit({ max: 10, window: Number.NaN, keyGenerator: () => "k" })).toThrow(CelsianError);
    expect(() => rateLimit({ max: 10, window: 0, keyGenerator: () => "k" })).toThrow(CelsianError);
    expect(() => rateLimit({ max: 10, window: -1, keyGenerator: () => "k" })).toThrow(CelsianError);
  });

  it("fails closed: throws CelsianError when `max` is missing/NaN/non-positive", () => {
    expect(() => rateLimit({ max: undefined as unknown as number, window: 60_000, keyGenerator: () => "k" })).toThrow(
      CelsianError,
    );
    expect(() => rateLimit({ max: Number.NaN, window: 60_000, keyGenerator: () => "k" })).toThrow(CelsianError);
    expect(() => rateLimit({ max: 0, window: 60_000, keyGenerator: () => "k" })).toThrow(CelsianError);
  });

  it("should throw CelsianError when trustProxy is false and no keyGenerator provided", () => {
    expect(() =>
      rateLimit({
        max: 10,
        window: 60_000,
        trustProxy: false,
      }),
    ).toThrow(CelsianError);
  });

  it("should throw CelsianError by default (trustProxy defaults to false) without keyGenerator", () => {
    expect(() =>
      rateLimit({
        max: 10,
        window: 60_000,
      }),
    ).toThrow(CelsianError);
  });

  it("should NOT throw when trustProxy is false but a custom keyGenerator is provided", async () => {
    const app = createApp();
    await app.register(
      rateLimit({
        max: 10,
        window: 60_000,
        trustProxy: false,
        keyGenerator: () => "custom-key",
      }),
      { encapsulate: false },
    );

    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    const res = await app.inject({ url: "/api" });
    expect(res.status).toBe(200);
  });
});
