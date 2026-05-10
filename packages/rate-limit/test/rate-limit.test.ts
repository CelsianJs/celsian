import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { MemoryRateLimitStore, rateLimit } from "../src/index.js";

describe("@celsian/rate-limit", () => {
  it("refuses ambiguous default keying instead of silently disabling limits", () => {
    expect(() => rateLimit({ max: 1, window: 60_000 })).toThrow("requires either a keyGenerator or trustProxy:true");
  });

  it("uses proxy headers only when explicitly trusted", async () => {
    const app = createApp();
    await app.register(rateLimit({ max: 1, window: 60_000, trustProxy: true }), { encapsulate: false });
    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    const headers = { "x-forwarded-for": "203.0.113.10" };
    expect((await app.inject({ url: "/api", headers })).status).toBe(200);
    expect((await app.inject({ url: "/api", headers })).status).toBe(429);
  });

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
});
