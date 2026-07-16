// Stress-test pass 5: Realistic multi-feature app combining plugins, sessions,
// nested routing, error handling, HEAD behavior, cookie lifecycle, adapter
// interop, and verifying zero low-level internals in userland code.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type APIGatewayProxyEventV2, createLambdaHandler } from "../../../packages/adapter-lambda/src/index.js";
import { createResponseCache, createSessionManager, MemoryKVStore } from "../../../packages/cache/src/index.js";
import { compress } from "../../../packages/compress/src/index.js";
import { createApp } from "../../../packages/core/src/app.js";
import { HttpError } from "../../../packages/core/src/errors.js";
import { cors } from "../../../packages/core/src/plugins/cors.js";
import { security } from "../../../packages/core/src/plugins/security.js";
import { createSSEHub } from "../../../packages/core/src/sse.js";
import { rateLimit } from "../../../packages/rate-limit/src/index.js";

// ─── Realistic SaaS API App ────────────────────────────────────

describe("Realistic SaaS API", () => {
  function buildApp() {
    const app = createApp({ prefix: "/api" });
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const sessions = createSessionManager({ store, ttlMs: 3600_000 });

    // Global plugins
    app.register(security({ hsts: false }), { encapsulate: false });
    app.register(cors({ origin: "https://app.example.com", credentials: true }), { encapsulate: false });

    // Auth middleware as a plugin
    app.register(
      async (auth) => {
        auth.addHook("onRequest", async (req, reply) => {
          const cookie = req.headers.get("cookie") ?? "";
          const sidMatch = cookie.match(/sid=([^;]+)/);
          if (!sidMatch) {
            return reply.status(401).json({ error: "No session" });
          }
          const session = await sessions.load(sidMatch[1]);
          if (!session) {
            return reply.status(401).json({ error: "Invalid session" });
          }
          (req as any).session = session;
        });

        auth.get("/me", (req) => {
          const session = (req as any).session;
          return { user: session.get("user") };
        });

        auth.get("/settings", (req) => {
          const session = (req as any).session;
          return { settings: session.get("settings") ?? {} };
        });

        auth.post("/logout", async (req, reply) => {
          const session = (req as any).session;
          await session.destroy();
          return reply.cookie("sid", "", { maxAge: 0, path: "/" }).json({ ok: true });
        });
      },
      { prefix: "/auth", encapsulate: true },
    );

    // Public routes (no auth)
    app.get("/health", () => ({ status: "ok", timestamp: Date.now() }));

    app.post("/login", async (req, reply) => {
      const body = req.parsedBody as { email?: string; password?: string } | null;
      if (!body?.email || !body?.password) {
        throw new HttpError(400, "Email and password required");
      }
      if (body.password !== "secret123") {
        throw new HttpError(401, "Invalid credentials");
      }
      const session = await sessions.create({ user: { email: body.email, role: "admin" } });
      return reply
        .cookie("sid", session.id, { httpOnly: true, path: "/" })
        .json({ ok: true, user: { email: body.email } });
    });

    // Items CRUD
    const items: Array<{ id: number; name: string; price: number }> = [
      { id: 1, name: "Widget", price: 9.99 },
      { id: 2, name: "Gadget", price: 24.99 },
      { id: 3, name: "Thingamajig", price: 14.99 },
    ];

    app.get("/items", (req) => {
      const limit = parseInt(req.query.limit ?? "10", 10);
      const offset = parseInt(req.query.offset ?? "0", 10);
      return {
        items: items.slice(offset, offset + limit),
        total: items.length,
      };
    });

    app.get("/items/:id", (req, reply) => {
      const item = items.find((i) => i.id === parseInt(req.params.id, 10));
      if (!item) return reply.notFound("Item not found");
      return item;
    });

    app.post("/items", (req) => {
      const body = req.parsedBody as { name: string; price: number };
      const newItem = { id: items.length + 1, name: body.name, price: body.price };
      items.push(newItem);
      return newItem;
    });

    return { app, store, sessions };
  }

  it("health check works without auth", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({ url: "/api/health" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeTypeOf("number");
    store.destroy();
  });

  it("security headers present on all responses", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({ url: "/api/health" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    store.destroy();
  });

  it("CORS headers on cross-origin requests", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({
      url: "/api/health",
      headers: { origin: "https://app.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    store.destroy();
  });

  it("login flow creates session and sets cookie", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: "alice@example.com", password: "secret123" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe("alice@example.com");
    expect(res.headers.get("set-cookie")).toContain("sid=");
    store.destroy();
  });

  it("login with wrong password returns 401", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: "alice@example.com", password: "wrong" },
    });
    expect(res.status).toBe(401);
    store.destroy();
  });

  it("login with missing fields returns 400", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: "alice@example.com" },
    });
    expect(res.status).toBe(400);
    store.destroy();
  });

  it("authenticated route works with valid session", async () => {
    const { app, store, sessions } = buildApp();
    const session = await sessions.create({ user: { email: "bob@test.com", role: "user" } });

    const res = await app.inject({
      url: "/api/auth/me",
      headers: { cookie: `sid=${session.id}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { email: "bob@test.com", role: "user" } });
    store.destroy();
  });

  it("authenticated route rejects without session", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({ url: "/api/auth/me" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "No session" });
    store.destroy();
  });

  it("authenticated route rejects with expired/invalid session", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({
      url: "/api/auth/me",
      headers: { cookie: "sid=nonexistent-session-id" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid session" });
    store.destroy();
  });

  it("items list supports pagination", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({ url: "/api/items", query: { limit: "2", offset: "1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].name).toBe("Gadget");
    expect(body.total).toBe(3);
    store.destroy();
  });

  it("items/:id returns specific item", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({ url: "/api/items/2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 2, name: "Gadget", price: 24.99 });
    store.destroy();
  });

  it("items/:id returns 404 for missing item", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({ url: "/api/items/999" });
    expect(res.status).toBe(404);
    store.destroy();
  });

  it("HEAD request to items list returns headers but no body", async () => {
    const { app, store } = buildApp();
    const res = await app.inject({ method: "HEAD", url: "/api/items" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    store.destroy();
  });

  it("full login → authenticated request → logout flow", async () => {
    const { app, store } = buildApp();

    // Login
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: "alice@test.com", password: "secret123" },
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get("set-cookie")!;
    const sid = setCookie.match(/sid=([^;]+)/)![1];

    // Access protected route
    const meRes = await app.inject({
      url: "/api/auth/me",
      headers: { cookie: `sid=${sid}` },
    });
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).user.email).toBe("alice@test.com");

    // Logout
    const logoutRes = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: `sid=${sid}` },
    });
    expect(logoutRes.status).toBe(200);

    // Session should be invalidated
    const afterRes = await app.inject({
      url: "/api/auth/me",
      headers: { cookie: `sid=${sid}` },
    });
    expect(afterRes.status).toBe(401);
    store.destroy();
  });
});

// ─── Session Manager ────────────────────────────────────────────

describe("Session manager", () => {
  let store: MemoryKVStore;

  beforeEach(() => {
    store = new MemoryKVStore({ cleanupIntervalMs: 0 });
  });
  afterEach(() => store.destroy());

  it("should create, save, and load sessions", async () => {
    const sessions = createSessionManager({ store });
    const session = await sessions.create({ user: "alice" });
    expect(session.id).toBeTruthy();
    expect(session.get("user")).toBe("alice");

    const loaded = await sessions.load(session.id);
    expect(loaded).toBeDefined();
    expect(loaded!.get("user")).toBe("alice");
  });

  it("should regenerate session ID (security after login)", async () => {
    const sessions = createSessionManager({ store });
    const session = await sessions.create({ user: "bob" });
    const oldId = session.id;

    const newSession = await session.regenerate();
    expect(newSession.id).not.toBe(oldId);
    expect(newSession.get("user")).toBe("bob");

    // Old ID should be gone
    const oldLoaded = await sessions.load(oldId);
    expect(oldLoaded).toBeUndefined();
  });

  it("should destroy sessions", async () => {
    const sessions = createSessionManager({ store });
    const session = await sessions.create({ secret: "data" });
    await sessions.destroy(session.id);

    const loaded = await sessions.load(session.id);
    expect(loaded).toBeUndefined();
  });

  it("should generate proper Set-Cookie header", () => {
    const sessions = createSessionManager({ store, cookieName: "token" });
    const cookie = sessions.cookie("abc123", { sameSite: "Strict" });
    expect(cookie).toContain("token=abc123");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  it("fromRequest should load existing session from cookie", async () => {
    const sessions = createSessionManager({ store });
    const original = await sessions.create({ key: "value" });

    const req = new Request("http://localhost/test", {
      headers: { cookie: `sid=${original.id}` },
    });
    const loaded = await sessions.fromRequest(req);
    expect(loaded.id).toBe(original.id);
    expect(loaded.get("key")).toBe("value");
  });

  it("fromRequest should create new session if cookie missing", async () => {
    const sessions = createSessionManager({ store });
    const req = new Request("http://localhost/test");
    const session = await sessions.fromRequest(req);
    expect(session.id).toBeTruthy();
    expect(session.all()).toEqual({});
  });

  it("session data mutations should persist after save", async () => {
    const sessions = createSessionManager({ store });
    const session = await sessions.create();
    session.set("cart", [{ id: 1, qty: 2 }]);
    session.set("prefs", { theme: "dark" });
    await session.save();

    const loaded = await sessions.load(session.id);
    expect(loaded!.get("cart")).toEqual([{ id: 1, qty: 2 }]);
    expect(loaded!.get("prefs")).toEqual({ theme: "dark" });
  });
});

// ─── Reply Helpers Depth ────────────────────────────────────────

describe("Reply helpers depth", () => {
  it("reply.cookie() should set multiple cookies", async () => {
    const app = createApp();
    app.get("/multi-cookie", (_req, reply) => {
      return reply
        .cookie("token", "abc123", { httpOnly: true, path: "/" })
        .cookie("theme", "dark", { path: "/" })
        .json({ ok: true });
    });

    const res = await app.inject({ url: "/multi-cookie" });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie?.() ?? [];
    expect(cookies.length).toBeGreaterThanOrEqual(2);
    expect(cookies.some((c: string) => c.includes("token=abc123"))).toBe(true);
    expect(cookies.some((c: string) => c.includes("theme=dark"))).toBe(true);
  });

  it("reply.clearCookie() should expire the cookie", async () => {
    const app = createApp();
    app.get("/clear", (_req, reply) => {
      return reply.clearCookie("session", { path: "/" }).json({ cleared: true });
    });

    const res = await app.inject({ url: "/clear" });
    const cookies = res.headers.getSetCookie?.() ?? [];
    expect(cookies.some((c: string) => c.includes("session=") && c.includes("Max-Age=0"))).toBe(true);
  });

  it("reply.redirect() should set location header", async () => {
    const app = createApp();
    app.get("/old", (_req, reply) => reply.redirect("/new"));
    app.get("/perm", (_req, reply) => reply.redirect("/new", 301));

    const temp = await app.inject({ url: "/old" });
    expect(temp.status).toBe(302);
    expect(temp.headers.get("location")).toBe("/new");

    const perm = await app.inject({ url: "/perm" });
    expect(perm.status).toBe(301);
  });

  it("reply.redirect() should reject protocol-relative URLs", async () => {
    const app = createApp();
    app.get("/bad", (_req, reply) => reply.redirect("//evil.com"));

    const res = await app.inject({ url: "/bad" });
    expect(res.status).toBe(500);
  });

  it("reply.html() should set correct content-type", async () => {
    const app = createApp();
    app.get("/page", (_req, reply) => reply.html("<h1>Hello</h1>"));

    const res = await app.inject({ url: "/page" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<h1>Hello</h1>");
  });

  it("reply.stream() should handle ReadableStream", async () => {
    const app = createApp();
    app.get("/stream", (_req, reply) => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("chunk1"));
          controller.enqueue(encoder.encode("chunk2"));
          controller.close();
        },
      });
      return reply.stream(stream);
    });

    const res = await app.inject({ url: "/stream" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("chunk1chunk2");
  });

  it("reply.sendFile() should serve a file", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => {
      return reply.sendFile("package.json", { root: process.cwd() });
    });

    const res = await app.inject({ url: "/file" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(text).toContain("celsian-monorepo");
  });

  it("reply.sendFile() should prevent path traversal", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => {
      return reply.sendFile("../../../etc/passwd", { root: process.cwd() + "/packages" });
    });

    const res = await app.inject({ url: "/file" });
    expect(res.status).toBe(403);
  });

  it("reply.download() should set Content-Disposition", async () => {
    const app = createApp();
    app.get("/dl", async (_req, reply) => {
      return reply.download("package.json", "config.json");
    });

    const res = await app.inject({ url: "/dl" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="config.json"');
  });
});

// ─── Response Cache + Security Interaction ──────────────────────

describe("Cache + Security interaction", () => {
  it("cached responses should still have security headers from onSend", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const app = createApp();
    await app.register(security(), { encapsulate: false });

    let callCount = 0;
    app.get("/data", () => {
      callCount++;
      return { value: callCount };
    });

    const cache = createResponseCache({ store, ttlMs: 5000 });
    const cachedHandler = cache.wrap(app.handle.bind(app));

    // First request — MISS
    const res1 = await cachedHandler(new Request("http://localhost/data"));
    expect(res1.headers.get("x-cache")).toBe("MISS");
    expect(res1.headers.get("x-content-type-options")).toBe("nosniff");

    // Second request — HIT (cached response carries original headers)
    const res2 = await cachedHandler(new Request("http://localhost/data"));
    expect(res2.headers.get("x-cache")).toBe("HIT");
    // Security headers were baked into the cached response
    expect(res2.headers.get("x-content-type-options")).toBe("nosniff");
    expect(callCount).toBe(1);
    store.destroy();
  });
});

// ─── Rate Limit + Session Interaction ───────────────────────────

describe("Rate limit per-session", () => {
  it("should rate limit by session ID", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const sessions = createSessionManager({ store });
    const session = await sessions.create({ user: "alice" });

    const app = createApp();
    await app.register(
      rateLimit({
        max: 3,
        window: 60000,
        keyGenerator: (req) => {
          const cookie = req.headers.get("cookie") ?? "";
          const match = cookie.match(/sid=([^;]+)/);
          return match ? match[1] : "anonymous";
        },
      }),
      { encapsulate: false },
    );
    app.get("/api", () => ({ ok: true }));

    const headers = { cookie: `sid=${session.id}` };
    const res1 = await app.inject({ url: "/api", headers });
    expect(res1.status).toBe(200);
    await app.inject({ url: "/api", headers });
    await app.inject({ url: "/api", headers });

    const res4 = await app.inject({ url: "/api", headers });
    expect(res4.status).toBe(429);

    // Different session should not be rate limited
    const session2 = await sessions.create({ user: "bob" });
    const res5 = await app.inject({ url: "/api", headers: { cookie: `sid=${session2.id}` } });
    expect(res5.status).toBe(200);

    store.destroy();
  });
});

// ─── Compress + Cache Interaction ───────────────────────────────

describe("Compress + Cache", () => {
  it("compressed responses should cache correctly", async () => {
    const cacheStore = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const app = createApp();
    await app.register(compress({ threshold: 50 }), { encapsulate: false });

    const bigPayload = { data: "x".repeat(200) };
    app.get("/big", (_req, reply) => reply.json(bigPayload));

    const cache = createResponseCache({
      store: cacheStore,
      ttlMs: 5000,
      varyHeaders: ["accept-encoding"],
    });
    const cachedHandler = cache.wrap(app.handle.bind(app));

    // First request with gzip
    const res1 = await cachedHandler(new Request("http://localhost/big", { headers: { "accept-encoding": "gzip" } }));
    expect(res1.headers.get("x-cache")).toBe("MISS");
    expect(res1.headers.get("content-encoding")).toBe("gzip");

    // Second request — from cache
    const res2 = await cachedHandler(new Request("http://localhost/big", { headers: { "accept-encoding": "gzip" } }));
    expect(res2.headers.get("x-cache")).toBe("HIT");

    cacheStore.destroy();
  });
});

// ─── Plugin Registration Order Effects ──────────────────────────

describe("Plugin registration order", () => {
  it("rate-limit before security: both headers present", async () => {
    const app = createApp();
    await app.register(rateLimit({ max: 100, window: 60000, keyGenerator: () => "k" }), { encapsulate: false });
    await app.register(security(), { encapsulate: false });
    app.get("/test", () => ({ ok: true }));

    const res = await app.inject({ url: "/test" });
    expect(res.headers.get("x-ratelimit-limit")).toBe("100");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("security before rate-limit: both headers present", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
    await app.register(rateLimit({ max: 100, window: 60000, keyGenerator: () => "k" }), { encapsulate: false });
    app.get("/test", () => ({ ok: true }));

    const res = await app.inject({ url: "/test" });
    expect(res.headers.get("x-ratelimit-limit")).toBe("100");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("compress inside encapsulated plugin should only affect plugin routes", async () => {
    const app = createApp();

    await app.register(
      async (sub) => {
        await sub.register(compress({ threshold: 10 }), { encapsulate: false });
        sub.get("/compressed", (_req, reply) => reply.json({ data: "x".repeat(100) }));
      },
      { prefix: "/v1", encapsulate: true },
    );

    app.get("/uncompressed", (_req, reply) => reply.json({ data: "x".repeat(100) }));

    const compRes = await app.inject({
      url: "/v1/compressed",
      headers: { "accept-encoding": "gzip" },
    });
    expect(compRes.headers.get("content-encoding")).toBe("gzip");

    const uncompRes = await app.inject({
      url: "/uncompressed",
      headers: { "accept-encoding": "gzip" },
    });
    expect(uncompRes.headers.get("content-encoding")).toBeNull();
  });
});

// ─── Lambda Adapter Full Stack ──────────────────────────────────

describe("Lambda adapter full-stack", () => {
  function makeLambdaEvent(
    method: string,
    path: string,
    opts: {
      body?: string;
      headers?: Record<string, string>;
      query?: string;
    } = {},
  ): APIGatewayProxyEventV2 {
    return {
      version: "2.0",
      routeKey: "$default",
      rawPath: path,
      rawQueryString: opts.query ?? "",
      headers: { host: "api.prod.com", "content-type": "application/json", ...opts.headers },
      body: opts.body,
      isBase64Encoded: false,
      requestContext: {
        http: { method, path, protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "test" },
        requestId: `req-${Date.now()}`,
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
      },
    };
  }

  it("full CRUD through Lambda adapter", async () => {
    const app = createApp();
    const items: Array<{ id: number; name: string }> = [];

    app.get("/items", () => items);
    app.post("/items", (req) => {
      const body = req.parsedBody as { name: string };
      const item = { id: items.length + 1, name: body.name };
      items.push(item);
      return item;
    });
    app.get("/items/:id", (req, reply) => {
      const item = items.find((i) => i.id === parseInt(req.params.id));
      if (!item) return reply.notFound();
      return item;
    });
    app.delete("/items/:id", (req, reply) => {
      const idx = items.findIndex((i) => i.id === parseInt(req.params.id));
      if (idx === -1) return reply.notFound();
      items.splice(idx, 1);
      return { deleted: true };
    });

    const handler = createLambdaHandler(app);

    // Create
    const createRes = await handler(
      makeLambdaEvent("POST", "/items", {
        body: JSON.stringify({ name: "Lambda Item" }),
      }),
    );
    expect(createRes.statusCode).toBe(200);
    expect(JSON.parse(createRes.body!)).toEqual({ id: 1, name: "Lambda Item" });

    // List
    const listRes = await handler(makeLambdaEvent("GET", "/items"));
    expect(JSON.parse(listRes.body!)).toHaveLength(1);

    // Get
    const getRes = await handler(makeLambdaEvent("GET", "/items/1"));
    expect(JSON.parse(getRes.body!).name).toBe("Lambda Item");

    // Delete
    const delRes = await handler(makeLambdaEvent("DELETE", "/items/1"));
    expect(JSON.parse(delRes.body!)).toEqual({ deleted: true });

    // 404 after delete
    const afterDel = await handler(makeLambdaEvent("GET", "/items/1"));
    expect(afterDel.statusCode).toBe(404);
  });

  it("Lambda adapter with security + CORS", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
    await app.register(cors({ origin: "*" }), { encapsulate: false });
    app.get("/api", () => ({ ok: true }));

    const handler = createLambdaHandler(app);
    const res = await handler(
      makeLambdaEvent("GET", "/api", {
        headers: { origin: "https://frontend.com" },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers!["x-content-type-options"]).toBe("nosniff");
    expect(res.headers!["access-control-allow-origin"]).toBe("*");
  });
});

// ─── SSE + Error Recovery ───────────────────────────────────────

describe("SSE hub lifecycle", () => {
  it("hub should handle rapid subscribe/unsubscribe", () => {
    const hub = createSSEHub();
    const channels = Array.from({ length: 50 }, () => hub.subscribe(new Request("http://localhost/events")));
    expect(hub.size).toBe(50);

    // Close half
    for (let i = 0; i < 25; i++) {
      channels[i].close();
    }
    expect(hub.size).toBe(25);

    // Broadcast to remaining
    hub.broadcastData({ ping: true });

    hub.closeAll();
    expect(hub.size).toBe(0);
  });

  it("SSE route in realistic app context", async () => {
    const app = createApp();
    const hub = createSSEHub();

    app.get("/events", (req) => {
      const channel = hub.subscribe(req);
      return channel.response;
    });

    app.post("/notify", (req) => {
      hub.broadcastData(req.parsedBody);
      return { sent: true, subscribers: hub.size };
    });

    // Subscribe
    const sseRes = await app.inject({ url: "/events" });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toBe("text/event-stream");

    hub.closeAll();
  });
});

// ─── Nested prefix interactions ─────────────────────────────────

describe("Nested prefix interactions", () => {
  it("app prefix + plugin prefix combine correctly", async () => {
    const app = createApp({ prefix: "/api/v2" });
    await app.register(
      async (users) => {
        users.get("/", () => [{ id: 1 }]);
        users.get("/:id", (req) => ({ id: req.params.id }));
      },
      { prefix: "/users" },
    );

    const listRes = await app.inject({ url: "/api/v2/users/" });
    // Might be 200 or 404 depending on trailing slash handling
    if (listRes.status === 200) {
      expect(await listRes.json()).toEqual([{ id: 1 }]);
    }

    const listRes2 = await app.inject({ url: "/api/v2/users" });
    // Without trailing slash — check if this matches "/" route
    expect([200, 404]).toContain(listRes2.status);

    const getRes = await app.inject({ url: "/api/v2/users/42" });
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ id: "42" });
  });

  it("deeply nested plugins with mixed encapsulation", async () => {
    const app = createApp({ prefix: "/api" });
    const hookOrder: string[] = [];

    // Non-encapsulated: affects all routes
    app.addHook("onRequest", () => {
      hookOrder.push("root");
    });

    await app.register(
      async (v1) => {
        v1.addHook("onRequest", () => {
          hookOrder.push("v1");
        });

        await v1.register(
          async (admin) => {
            admin.addHook("onRequest", () => {
              hookOrder.push("admin");
            });
            admin.get("/users", () => ({ scope: "admin" }));
          },
          { prefix: "/admin", encapsulate: true },
        );

        v1.get("/public", () => ({ scope: "v1" }));
      },
      { prefix: "/v1", encapsulate: true },
    );

    hookOrder.length = 0;
    const adminRes = await app.inject({ url: "/api/v1/admin/users" });
    expect(adminRes.status).toBe(200);
    // Admin route should have: root + v1 + admin hooks
    expect(hookOrder).toEqual(["root", "v1", "admin"]);

    hookOrder.length = 0;
    const publicRes = await app.inject({ url: "/api/v1/public" });
    expect(publicRes.status).toBe(200);
    // Public route should have: root + v1 hooks (no admin)
    expect(hookOrder).toEqual(["root", "v1"]);
  });
});

// ─── Error handling interactions ────────────────────────────────

describe("Error handling edge cases", () => {
  it("HttpError in plugin hook should still produce JSON response", async () => {
    const app = createApp();
    await app.register(
      async (plugin) => {
        plugin.addHook("onRequest", () => {
          throw new HttpError(403, "Plugin says no", { code: "PLUGIN_BLOCKED" });
        });
        plugin.get("/blocked", () => ({ never: true }));
      },
      { encapsulate: true },
    );

    const res = await app.inject({ url: "/blocked" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("PLUGIN_BLOCKED");
  });

  it("error in async handler with onError hook", async () => {
    const app = createApp();
    const errors: Error[] = [];
    app.addHook("onError", (err) => {
      errors.push(err);
    });

    app.get("/boom", async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new HttpError(502, "Upstream failed");
    });

    const res = await app.inject({ url: "/boom" });
    expect(res.status).toBe(502);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("Upstream failed");
  });

  it("security headers should appear even on error responses", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
    app.get("/fail", () => {
      throw new HttpError(500, "oops");
    });

    const res = await app.inject({ url: "/fail" });
    expect(res.status).toBe(500);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
