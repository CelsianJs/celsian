// Stress-test pass 3: adapters, plugins (compress, rate-limit, cache), CLI utils, DX ergonomics

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type APIGatewayProxyEventV2, createLambdaHandler } from "../packages/adapter-lambda/src/index.js";
import { createResponseCache, MemoryKVStore } from "../packages/cache/src/index.js";
import { compress } from "../packages/compress/src/index.js";
import { createApp } from "../packages/core/src/app.js";
import { cors } from "../packages/core/src/plugins/cors.js";
import { security } from "../packages/core/src/plugins/security.js";
import { MemoryRateLimitStore, rateLimit } from "../packages/rate-limit/src/index.js";

// ─── Lambda Adapter ────────────────────────────────────────────

describe("Lambda Adapter", () => {
  function makeLambdaEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
    return {
      version: "2.0",
      routeKey: "$default",
      rawPath: "/hello",
      rawQueryString: "",
      headers: { "content-type": "application/json", host: "example.com" },
      isBase64Encoded: false,
      requestContext: {
        http: { method: "GET", path: "/hello", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
        requestId: "test-req-1",
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
      },
      ...overrides,
    };
  }

  it("should convert Lambda event to Request and back", async () => {
    const app = createApp();
    app.get("/hello", () => ({ greeting: "world" }));
    const handler = createLambdaHandler(app);

    const result = await handler(makeLambdaEvent());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ greeting: "world" });
    expect(result.isBase64Encoded).toBe(false);
  });

  it("should handle POST with body", async () => {
    const app = createApp();
    app.post("/echo", (req) => ({ got: req.parsedBody }));
    const handler = createLambdaHandler(app);

    const result = await handler(
      makeLambdaEvent({
        rawPath: "/echo",
        body: JSON.stringify({ name: "test" }),
        requestContext: {
          http: { method: "POST", path: "/echo", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
          requestId: "test-req-2",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!).got).toEqual({ name: "test" });
  });

  it("should handle base64-encoded body", async () => {
    const app = createApp();
    app.post("/upload", (req) => {
      const body = req.parsedBody as string;
      return { length: body.length, content: body };
    });
    const handler = createLambdaHandler(app);

    const bodyText = "Hello base64 world";
    const result = await handler(
      makeLambdaEvent({
        rawPath: "/upload",
        body: Buffer.from(bodyText).toString("base64"),
        isBase64Encoded: true,
        headers: { "content-type": "text/plain", host: "example.com" },
        requestContext: {
          http: { method: "POST", path: "/upload", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
          requestId: "test-req-3",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!).content).toBe(bodyText);
  });

  it("should pass through query string", async () => {
    const app = createApp();
    app.get("/search", (req) => ({ q: req.query.q, page: req.query.page }));
    const handler = createLambdaHandler(app);

    const result = await handler(makeLambdaEvent({ rawPath: "/search", rawQueryString: "q=celsian&page=2" }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body.q).toBe("celsian");
    expect(body.page).toBe("2");
  });

  it("should handle 404 gracefully", async () => {
    const app = createApp();
    app.get("/exists", () => ({ ok: true }));
    const handler = createLambdaHandler(app);

    const result = await handler(makeLambdaEvent({ rawPath: "/nope" }));
    expect(result.statusCode).toBe(404);
  });

  it("should handle text/plain responses as text (not binary)", async () => {
    const app = createApp();
    app.get("/text", (_req, reply) => reply.send("plain text response"));
    const handler = createLambdaHandler(app);

    const result = await handler(makeLambdaEvent({ rawPath: "/text" }));
    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(false);
    expect(result.body).toBe("plain text response");
  });

  it("should handle application/javascript as text (not binary)", async () => {
    const app = createApp();
    app.get("/script", (_req, reply) => {
      reply.header("content-type", "application/javascript");
      return reply.send("console.log('hi')");
    });
    const handler = createLambdaHandler(app);

    const result = await handler(makeLambdaEvent({ rawPath: "/script" }));
    expect(result.isBase64Encoded).toBe(false);
  });

  it("should handle errors without crashing", async () => {
    const app = createApp();
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    const handler = createLambdaHandler(app);

    const result = await handler(makeLambdaEvent({ rawPath: "/boom" }));
    expect(result.statusCode).toBe(500);
  });
});

// ─── Response Cache ────────────────────────────────────────────

describe("Response Cache", () => {
  let store: MemoryKVStore;

  beforeEach(() => {
    store = new MemoryKVStore({ cleanupIntervalMs: 0 });
  });

  afterEach(() => {
    store.destroy();
  });

  it("should cache GET responses and serve from cache on second hit", async () => {
    const app = createApp();
    let callCount = 0;
    app.get("/data", () => {
      callCount++;
      return { value: callCount };
    });

    const cache = createResponseCache({ store, ttlMs: 5000 });
    const cachedHandler = cache.wrap(app.handle.bind(app));

    const req1 = new Request("http://localhost/data");
    const res1 = await cachedHandler(req1);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("x-cache")).toBe("MISS");
    expect(await res1.json()).toEqual({ value: 1 });

    const req2 = new Request("http://localhost/data");
    const res2 = await cachedHandler(req2);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-cache")).toBe("HIT");
    expect(await res2.json()).toEqual({ value: 1 });
    expect(callCount).toBe(1);
  });

  it("should not cache POST requests by default", async () => {
    const app = createApp();
    let callCount = 0;
    app.post("/data", () => {
      callCount++;
      return { value: callCount };
    });

    const cache = createResponseCache({ store });
    const cachedHandler = cache.wrap(app.handle.bind(app));

    const req1 = new Request("http://localhost/data", { method: "POST" });
    await cachedHandler(req1);
    const req2 = new Request("http://localhost/data", { method: "POST" });
    await cachedHandler(req2);
    expect(callCount).toBe(2);
  });

  it("should respect exclude paths", async () => {
    const app = createApp();
    let callCount = 0;
    app.get("/api/health", () => {
      callCount++;
      return { ok: true };
    });

    const cache = createResponseCache({ store, exclude: ["/api/health"] });
    const cachedHandler = cache.wrap(app.handle.bind(app));

    await cachedHandler(new Request("http://localhost/api/health"));
    await cachedHandler(new Request("http://localhost/api/health"));
    expect(callCount).toBe(2);
  });

  it("should invalidate cached entries", async () => {
    const app = createApp();
    let callCount = 0;
    app.get("/data", () => {
      callCount++;
      return { value: callCount };
    });

    const cache = createResponseCache({ store });
    const cachedHandler = cache.wrap(app.handle.bind(app));

    await cachedHandler(new Request("http://localhost/data"));
    expect(callCount).toBe(1);

    await cache.invalidate("GET:/data");

    const res = await cachedHandler(new Request("http://localhost/data"));
    expect(callCount).toBe(2);
    expect(await res.json()).toEqual({ value: 2 });
  });

  it("should support vary headers for content negotiation", async () => {
    const app = createApp();
    app.get("/content", (req) => {
      const lang = req.headers.get("accept-language") ?? "en";
      return { lang };
    });

    const cache = createResponseCache({ store, varyHeaders: ["accept-language"] });
    const cachedHandler = cache.wrap(app.handle.bind(app));

    const res1 = await cachedHandler(new Request("http://localhost/content", { headers: { "accept-language": "en" } }));
    expect(await res1.json()).toEqual({ lang: "en" });

    const res2 = await cachedHandler(new Request("http://localhost/content", { headers: { "accept-language": "fr" } }));
    expect(await res2.json()).toEqual({ lang: "fr" });
    expect(res2.headers.get("x-cache")).toBe("MISS");
  });

  it("should not cache non-200 responses by default", async () => {
    const app = createApp();
    let callCount = 0;
    app.get("/fail", (_req, reply) => {
      callCount++;
      return reply.status(500).json({ error: "fail" });
    });

    const cache = createResponseCache({ store });
    const cachedHandler = cache.wrap(app.handle.bind(app));

    await cachedHandler(new Request("http://localhost/fail"));
    await cachedHandler(new Request("http://localhost/fail"));
    expect(callCount).toBe(2);
  });
});

// ─── Memory KV Store ────────────────────────────────────────────

describe("MemoryKVStore", () => {
  let store: MemoryKVStore;

  beforeEach(() => {
    store = new MemoryKVStore({ cleanupIntervalMs: 0 });
  });

  afterEach(() => {
    store.destroy();
  });

  it("should get/set/delete/has basics", async () => {
    await store.set("k1", "v1");
    expect(await store.get("k1")).toBe("v1");
    expect(await store.has("k1")).toBe(true);
    expect(await store.delete("k1")).toBe(true);
    expect(await store.get("k1")).toBeUndefined();
    expect(await store.has("k1")).toBe(false);
  });

  it("should expire values after TTL", async () => {
    vi.useFakeTimers();
    const timedStore = new MemoryKVStore({ cleanupIntervalMs: 0 });
    await timedStore.set("ephemeral", "gone-soon", 100);
    expect(await timedStore.get("ephemeral")).toBe("gone-soon");
    vi.advanceTimersByTime(150);
    expect(await timedStore.get("ephemeral")).toBeUndefined();
    timedStore.destroy();
    vi.useRealTimers();
  });

  it("should return correct TTL", async () => {
    await store.set("noTtl", "permanent");
    expect(await store.ttl("noTtl")).toBe(-1);
    expect(await store.ttl("nonexistent")).toBe(-2);

    await store.set("timed", "val", 10000);
    const remaining = await store.ttl("timed");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(10000);
  });

  it("should increment and decrement", async () => {
    expect(await store.incr("counter")).toBe(1);
    expect(await store.incr("counter")).toBe(2);
    expect(await store.incr("counter", 5)).toBe(7);
    expect(await store.decr("counter")).toBe(6);
    expect(await store.decr("counter", 3)).toBe(3);
  });

  it("should getMany and setMany", async () => {
    await store.setMany([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
      { key: "c", value: 3 },
    ]);
    const results = await store.getMany(["a", "b", "c", "d"]);
    expect(results).toEqual([1, 2, 3, undefined]);
  });

  it("should match glob patterns with keys()", async () => {
    await store.set("user:1:name", "Alice");
    await store.set("user:1:email", "alice@test.com");
    await store.set("user:2:name", "Bob");
    await store.set("post:1:title", "Hello");

    const userKeys = await store.keys("user:*:name");
    expect(userKeys.sort()).toEqual(["user:1:name", "user:2:name"]);

    const allUser1 = await store.keys("user:1:*");
    expect(allUser1.sort()).toEqual(["user:1:email", "user:1:name"]);
  });

  it("glob * should not match across colons (segment boundary)", async () => {
    await store.set("a:b:c", 1);
    await store.set("a:x", 2);

    const match = await store.keys("a:*");
    expect(match).toEqual(["a:x"]);
  });

  it("should clear with prefix", async () => {
    await store.set("cache:a", 1);
    await store.set("cache:b", 2);
    await store.set("session:a", 3);

    await store.clear("cache:");
    expect(await store.get("cache:a")).toBeUndefined();
    expect(await store.get("session:a")).toBe(3);
  });
});

// ─── Rate Limiter ────────────────────────────────────────────

describe("Rate Limiter", () => {
  it("should allow requests within limit", async () => {
    const app = createApp();
    await app.register(rateLimit({ max: 5, window: 60000, keyGenerator: () => "test-client" }), { encapsulate: false });
    app.get("/api", () => ({ ok: true }));

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ url: "/api" });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-ratelimit-limit")).toBe("5");
      expect(res.headers.get("x-ratelimit-remaining")).toBe(String(4 - i));
    }
  });

  it("should return 429 when limit exceeded", async () => {
    const app = createApp();
    await app.register(rateLimit({ max: 2, window: 60000, keyGenerator: () => "test-client" }), { encapsulate: false });
    app.get("/api", () => ({ ok: true }));

    await app.inject({ url: "/api" });
    await app.inject({ url: "/api" });
    const res = await app.inject({ url: "/api" });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too Many Requests");
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("should isolate keys per client", async () => {
    let clientId = "client-a";
    const app = createApp();
    await app.register(rateLimit({ max: 1, window: 60000, keyGenerator: () => clientId }), { encapsulate: false });
    app.get("/api", () => ({ ok: true }));

    const res1 = await app.inject({ url: "/api" });
    expect(res1.status).toBe(200);

    clientId = "client-b";
    const res2 = await app.inject({ url: "/api" });
    expect(res2.status).toBe(200);

    clientId = "client-a";
    const res3 = await app.inject({ url: "/api" });
    expect(res3.status).toBe(429);
  });

  it("should throw without trustProxy or keyGenerator", () => {
    expect(() => rateLimit({ max: 10, window: 60000 })).toThrow(/keyGenerator/);
  });

  it("should use X-Forwarded-For with trustProxy", async () => {
    const app = createApp();
    await app.register(rateLimit({ max: 1, window: 60000, trustProxy: true }), { encapsulate: false });
    app.get("/api", () => ({ ok: true }));

    const res1 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(res1.status).toBe(200);

    const res2 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(res2.status).toBe(429);

    const res3 = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "5.6.7.8" },
    });
    expect(res3.status).toBe(200);
  });

  it("MemoryRateLimitStore should clean up expired entries", async () => {
    vi.useFakeTimers();
    const memStore = new MemoryRateLimitStore();
    await memStore.increment("test", 100);
    vi.advanceTimersByTime(200);
    const result = await memStore.increment("test", 100);
    expect(result.count).toBe(1);
    memStore.destroy();
    vi.useRealTimers();
  });
});

// ─── Compress Plugin ────────────────────────────────────────────

describe("Compress Plugin", () => {
  it("should not compress small responses", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 1024 }), { encapsulate: false });
    app.get("/small", (_req, reply) => reply.json({ ok: true }));

    const res = await app.inject({
      url: "/small",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("should compress large JSON responses with gzip", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 100 }), { encapsulate: false });
    const largePayload = { data: "x".repeat(500) };
    app.get("/big", (_req, reply) => reply.json(largePayload));

    const res = await app.inject({
      url: "/big",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toContain("accept-encoding");
  });

  it("should compress large HTML responses", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 50 }), { encapsulate: false });
    const html = `<html><body>${"<p>paragraph</p>".repeat(20)}</body></html>`;
    app.get("/page", (_req, reply) => reply.html(html));

    const res = await app.inject({
      url: "/page",
      headers: { "accept-encoding": "deflate" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("deflate");
  });

  it("should not compress when client does not accept encoding", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });
    app.get("/data", (_req, reply) => reply.json({ big: "x".repeat(100) }));

    const res = await app.inject({ url: "/data" });
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("should negotiate encoding preference", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10, encodings: ["deflate", "gzip"] }), { encapsulate: false });
    app.get("/data", (_req, reply) => reply.json({ big: "x".repeat(100) }));

    const res = await app.inject({
      url: "/data",
      headers: { "accept-encoding": "deflate, gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("deflate");
  });
});

// ─── Security + CORS Composition ────────────────────────────────

describe("Security + CORS composition", () => {
  it("should apply both security and CORS headers", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
    await app.register(cors({ origin: "https://example.com" }), { encapsulate: false });
    app.get("/api", () => ({ ok: true }));

    const res = await app.inject({
      url: "/api",
      headers: { origin: "https://example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://example.com");
  });

  it("should apply security headers to CORS preflight", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
    await app.register(cors({ origin: "*" }), { encapsulate: false });
    app.get("/api", () => ({ ok: true }));

    const res = await app.inject({
      method: "OPTIONS",
      url: "/api",
      headers: {
        origin: "https://foo.com",
        "access-control-request-method": "POST",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("security headers should apply to 404 and 405 responses", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
    app.get("/exists", () => ({ ok: true }));

    const r404 = await app.inject({ url: "/nothing" });
    expect(r404.status).toBe(404);
    expect(r404.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r404.headers.get("x-frame-options")).toBe("DENY");
    expect(r404.headers.get("strict-transport-security")).toContain("max-age=");

    const r405 = await app.inject({ method: "DELETE", url: "/exists" });
    expect(r405.status).toBe(405);
    expect(r405.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r405.headers.get("x-frame-options")).toBe("DENY");
  });
});

// ─── Plugin Registration Ergonomics ────────────────────────────

describe("Plugin registration ergonomics", () => {
  it("should support multiple plugins registered sequentially", async () => {
    const app = createApp();
    const store = new MemoryRateLimitStore();

    await app.register(security(), { encapsulate: false });
    await app.register(rateLimit({ max: 100, window: 60000, keyGenerator: () => "test" }), { encapsulate: false });
    app.get("/api", () => ({ ok: true }));

    const res = await app.inject({ url: "/api" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-ratelimit-limit")).toBe("100");
    store.destroy();
  });

  it("rate-limit + security should both apply headers", async () => {
    const app = createApp();
    await app.register(security({ hsts: false }), { encapsulate: false });
    await app.register(rateLimit({ max: 10, window: 60000, keyGenerator: () => "k" }), { encapsulate: false });
    app.get("/test", () => "ok");

    const res = await app.inject({ url: "/test" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("9");
  });

  it("encapsulated plugin hooks should not leak to sibling routes", async () => {
    const app = createApp();

    await app.register(
      (instance) => {
        instance.addHook("onRequest", (_req, reply) => {
          reply.header("x-plugin-only", "true");
        });
        instance.get("/plugin-route", () => ({ from: "plugin" }));
      },
      { encapsulate: true },
    );

    app.get("/app-route", () => ({ from: "app" }));

    const pluginRes = await app.inject({ url: "/plugin-route" });
    expect(pluginRes.headers.get("x-plugin-only")).toBe("true");

    const appRes = await app.inject({ url: "/app-route" });
    expect(appRes.headers.get("x-plugin-only")).toBeNull();
  });
});

// ─── Handler Return DX (auto-serialization edge cases) ─────────

describe("Auto-serialization DX", () => {
  it("should auto-serialize arrays", async () => {
    const app = createApp();
    app.get("/list", () => [1, 2, 3]);

    const res = await app.inject({ url: "/list" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([1, 2, 3]);
  });

  it("should auto-serialize nested objects", async () => {
    const app = createApp();
    app.get("/nested", () => ({ a: { b: { c: 42 } } }));

    const res = await app.inject({ url: "/nested" });
    expect(await res.json()).toEqual({ a: { b: { c: 42 } } });
  });

  it("should auto-serialize numbers as JSON", async () => {
    const app = createApp();
    app.get("/num", () => 42);

    const res = await app.inject({ url: "/num" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("42");
  });

  it("should auto-serialize booleans", async () => {
    const app = createApp();
    app.get("/bool", () => true);

    const res = await app.inject({ url: "/bool" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("true");
  });

  it("should return 204 for null/undefined returns", async () => {
    const app = createApp();
    app.get("/nothing", () => {});

    const res = await app.inject({ url: "/nothing" });
    expect(res.status).toBe(204);
  });

  it("should handle async handlers returning objects", async () => {
    const app = createApp();
    app.get("/async", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { async: true };
    });

    const res = await app.inject({ url: "/async" });
    expect(await res.json()).toEqual({ async: true });
  });

  it("should not double-wrap Response objects", async () => {
    const app = createApp();
    app.get("/raw", () => new Response("raw", { status: 201 }));

    const res = await app.inject({ url: "/raw" });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("raw");
  });
});

// ─── Multi-hook ordering ────────────────────────────────────────

describe("Hook ordering and interaction", () => {
  it("onRequest hooks run in registration order", async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook("onRequest", () => {
      order.push("first");
    });
    app.addHook("onRequest", () => {
      order.push("second");
    });
    app.addHook("onRequest", () => {
      order.push("third");
    });
    app.get("/test", () => ({ ok: true }));

    await app.inject({ url: "/test" });
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("onSend hooks can modify reply headers", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, reply) => {
      reply.header("x-modified-in-onsend", "true");
    });
    app.get("/test", () => ({ ok: true }));

    const res = await app.inject({ url: "/test" });
    expect(res.headers.get("x-modified-in-onsend")).toBe("true");
  });

  it("preHandler can short-circuit with a Response", async () => {
    const app = createApp();
    app.get("/guarded", { preHandler: [(_req, reply) => reply.status(403).json({ error: "forbidden" })] }, () => ({
      shouldnt: "reach",
    }));

    const res = await app.inject({ url: "/guarded" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
});

// ─── Edge cases across the stack ────────────────────────────────

describe("Cross-cutting edge cases", () => {
  it("app prefix should work with plugins", async () => {
    const app = createApp({ prefix: "/v1" });
    await app.register(security(), { encapsulate: false });
    app.get("/users", () => [{ id: 1 }]);

    const res = await app.inject({ url: "/v1/users" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual([{ id: 1 }]);
  });

  it("multiple methods on same path should each work", async () => {
    const app = createApp();
    app.get("/resource", () => ({ method: "GET" }));
    app.post("/resource", () => ({ method: "POST" }));
    app.put("/resource", () => ({ method: "PUT" }));
    app.delete("/resource", () => ({ method: "DELETE" }));

    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/resource" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ method });
    }
  });

  it("POST with JSON payload should be parseable via req.json()", async () => {
    const app = createApp();
    app.post("/echo", async (req) => {
      const body = req.parsedBody ?? (await req.json());
      return { received: body };
    });

    const res = await app.inject({
      method: "POST",
      url: "/echo",
      payload: { key: "value" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: { key: "value" } });
  });

  it("inject() should support all HTTP methods", async () => {
    const app = createApp();
    app.patch("/item", () => ({ patched: true }));

    const res = await app.inject({ method: "PATCH", url: "/item" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ patched: true });
  });
});
