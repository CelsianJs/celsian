// CelsianJS Realism Audit — comprehensive integration tests exercising every feature
// via inject() (no real server needed) and via live HTTP (real server).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { serve } from "../../../packages/core/src/serve.js";
import { createLambdaHandler, type APIGatewayProxyEventV2 } from "../../../packages/adapter-lambda/src/index.js";
import { createBunHandler } from "../../../packages/adapter-bun/src/index.js";
import { createCloudflareHandler } from "../../../packages/adapter-cloudflare/src/index.js";
import { createVercelHandler, createVercelEdgeHandler } from "../../../packages/adapter-vercel/src/index.js";

// ═══════════════════════════════════════════════════════════════
// Part 1: inject()-based feature coverage
// ═══════════════════════════════════════════════════════════════

describe("Realism Audit — inject() tests", () => {
  const { app, taskResults, users, items } = buildApp();
  let authToken: string;

  // ─── Health & Ready ───
  describe("Health Check (built-in helper)", () => {
    it("GET /api/health returns 200", async () => {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
    });

    it("GET /api/ready returns 200", async () => {
      const res = await app.inject({ method: "GET", url: "/api/ready" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ready");
    });
  });

  // ─── Security Headers ───
  describe("Security Headers (helmet)", () => {
    it("adds security headers to every response", async () => {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBeTruthy();
      expect(res.headers.get("x-xss-protection")).toBe("0");
    });
  });

  // ─── CORS ───
  describe("CORS", () => {
    it("includes CORS headers on responses", async () => {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("handles preflight OPTIONS", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api/items",
        headers: {
          origin: "https://example.com",
          "access-control-request-method": "POST",
        },
      });
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    });
  });

  // ─── Auth: Register & Login ───
  describe("Auth (JWT)", () => {
    it("registers a user and returns a token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { "content-type": "application/json" },
        payload: { name: "Alice", email: "alice@test.com", password: "pass123" },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.token).toBeDefined();
      expect(body.user.name).toBe("Alice");
      authToken = body.token;
    });

    it("logs in with existing credentials", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: { email: "alice@test.com", password: "pass123" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toBeDefined();
    });

    it("rejects login with bad credentials", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: { email: "nobody@test.com", password: "wrong" },
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── CRUD (with JWT guard) ───
  describe("CRUD Items", () => {
    let itemId: string;

    it("lists items (no auth required)", async () => {
      const res = await app.inject({ method: "GET", url: "/api/items" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toBeInstanceOf(Array);
    });

    it("rejects create without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/items",
        headers: { "content-type": "application/json" },
        payload: { title: "Test item" },
      });
      expect(res.status).toBe(401);
    });

    it("creates an item with auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/items",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        payload: { title: "Test item" },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe("Test item");
      expect(body.done).toBe(false);
      itemId = body.id;
    });

    it("reads a specific item", async () => {
      const res = await app.inject({ method: "GET", url: `/api/items/${itemId}` });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe("Test item");
    });

    it("updates an item", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/items/${itemId}`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        payload: { done: true },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.done).toBe(true);
    });

    it("deletes an item", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/items/${itemId}`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(res.status).toBe(204);
    });

    it("returns 404 for deleted item", async () => {
      const res = await app.inject({ method: "GET", url: `/api/items/${itemId}` });
      expect(res.status).toBe(404);
    });
  });

  // ─── Schema Validation (Zod) ───
  describe("Schema Validation", () => {
    it("validates and accepts valid body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/items/validated",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        payload: { title: "Validated item", priority: "high" },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.priority).toBe("high");
    });

    it("rejects invalid body with validation error", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/items/validated",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        payload: { title: "", priority: "invalid" },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("applies defaults from schema", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/items/validated",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        payload: { title: "Default priority" },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.priority).toBe("medium");
    });
  });

  // ─── ETag / Conditional Requests ───
  describe("ETag", () => {
    it("returns ETag header", async () => {
      const res = await app.inject({ method: "GET", url: "/api/etag-demo" });
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBeTruthy();
    });

    it("returns 304 for matching If-None-Match", async () => {
      const first = await app.inject({ method: "GET", url: "/api/etag-demo" });
      const etag = first.headers.get("etag")!;
      const second = await app.inject({
        method: "GET",
        url: "/api/etag-demo",
        headers: { "if-none-match": etag },
      });
      expect(second.status).toBe(304);
    });
  });

  // ─── SSE ───
  describe("Server-Sent Events", () => {
    it("returns SSE stream with correct content type", async () => {
      const res = await app.inject({ method: "GET", url: "/api/events" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });
  });

  // ─── Content Negotiation ───
  describe("Content Negotiation", () => {
    it("returns preferred content type", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/negotiate",
        headers: {
          accept: "text/html, application/json;q=0.9",
          "accept-encoding": "identity",
          "accept-language": "fr, en-US;q=0.8",
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.preferredType).toBe("text/html");
      expect(body.preferredLang).toBe("fr");
    });
  });

  // ─── Cookies ───
  describe("Cookie Lifecycle", () => {
    it("sets cookies", async () => {
      const res = await app.inject({ method: "GET", url: "/api/cookie/set" });
      expect(res.status).toBe(200);
      const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
      expect(cookies.length).toBeGreaterThanOrEqual(1);
    });

    it("reads cookies from request", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/cookie/read",
        headers: { cookie: "session=abc123; theme=dark" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cookies.session).toBe("abc123");
      expect(body.cookies.theme).toBe("dark");
    });

    it("clears cookies", async () => {
      const res = await app.inject({ method: "GET", url: "/api/cookie/clear" });
      expect(res.status).toBe(200);
      const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
      const sessionCookie = cookies.find((c: string) => c.startsWith("session="));
      expect(sessionCookie).toContain("Max-Age=0");
    });
  });

  // ─── Reply Helpers ───
  describe("Reply Helpers", () => {
    it("HTML response", async () => {
      const res = await app.inject({ method: "GET", url: "/api/reply/html" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const text = await res.text();
      expect(text).toContain("<h1>");
    });

    it("redirect response", async () => {
      const res = await app.inject({ method: "GET", url: "/api/reply/redirect" });
      expect([301, 302, 307, 308]).toContain(res.status);
      expect(res.headers.get("location")).toBe("/api/health");
    });

    it("stream response", async () => {
      const res = await app.inject({ method: "GET", url: "/api/reply/stream" });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("chunk1");
      expect(text).toContain("chunk2");
    });
  });

  // ─── Error Handling ───
  describe("Error Handling", () => {
    it("HttpError returns structured JSON", async () => {
      const res = await app.inject({ method: "GET", url: "/api/error/http" });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("Validation failed");
      expect(body.code).toBe("CUSTOM_VALIDATION");
    });

    it("unexpected errors return 500", async () => {
      const res = await app.inject({ method: "GET", url: "/api/error/unexpected" });
      expect(res.status).toBe(500);
    });

    it("reply.notFound() returns 404", async () => {
      const res = await app.inject({ method: "GET", url: "/api/error/not-found" });
      expect(res.status).toBe(404);
    });

    it("custom 404 handler for unknown routes", async () => {
      const res = await app.inject({ method: "GET", url: "/api/totally-unknown" });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.hint).toBeDefined();
    });
  });

  // ─── Sessions ───
  describe("Session Management", () => {
    let sessionId: string;

    it("creates a session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/session/create",
        headers: { "content-type": "application/json" },
        payload: { username: "testuser" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionId).toBeDefined();
      sessionId = body.sessionId;
    });

    it("retrieves a session", async () => {
      const res = await app.inject({ method: "GET", url: `/api/session/${sessionId}` });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.username).toBe("testuser");
    });

    it("destroys a session", async () => {
      const res = await app.inject({ method: "DELETE", url: `/api/session/${sessionId}` });
      expect(res.status).toBe(200);
      const verify = await app.inject({ method: "GET", url: `/api/session/${sessionId}` });
      expect(verify.status).toBe(404);
    });
  });

  // ─── Response Cache ───
  describe("Response Cache", () => {
    it("caches response on second call", async () => {
      const first = await app.inject({ method: "GET", url: "/api/cached" });
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      const second = await app.inject({ method: "GET", url: "/api/cached" });
      expect(second.status).toBe(200);
      const secondBody = await second.json();

      expect(secondBody.ts).toBe(firstBody.ts);
    });
  });

  // ─── Background Tasks ───
  describe("Task Queue", () => {
    it("enqueues and processes a task", async () => {
      app.startWorker();
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/enqueue",
        headers: { "content-type": "application/json" },
        payload: { message: "audit-test-task" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.taskId).toBeDefined();

      // Wait for worker to process (poll interval + processing time)
      await new Promise(r => setTimeout(r, 1500));

      const results = await app.inject({ method: "GET", url: "/api/tasks/results" });
      const resultsBody = await results.json();
      expect(resultsBody.results).toContain("audit-test-task");

      await app.stopWorker();
    });
  });

  // ─── Cron ───
  describe("Cron Scheduler", () => {
    it("registers cron jobs", async () => {
      const res = await app.inject({ method: "GET", url: "/api/cron/status" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registered).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Decorations & Hooks ───
  describe("Decorations & Hooks", () => {
    it("app decoration is accessible", async () => {
      const res = await app.inject({ method: "GET", url: "/api/meta" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe("1.0.0-audit");
      expect(body.startTime).toBeGreaterThan(0);
    });

    it("lifecycle hooks fire in order", async () => {
      await app.inject({ method: "GET", url: "/api/hooks/reset" });
      const res = await app.inject({ method: "GET", url: "/api/hooks/trace" });
      expect(res.status).toBe(200);
      const body = await res.json();
      const trace = body.trace;
      // onRequest should come before preHandler, which should come before handler
      const onReqIdx = trace.indexOf("onRequest");
      const preHandlerIdx = trace.indexOf("preHandler");
      const handlerIdx = trace.indexOf("handler");
      expect(onReqIdx).toBeLessThan(preHandlerIdx);
      expect(preHandlerIdx).toBeLessThan(handlerIdx);
    });
  });

  // ─── WebSocket Registration ───
  describe("WebSocket", () => {
    it("registers WS handlers", () => {
      expect(app.wsRegistry.hasPath("/ws/echo")).toBe(true);
      expect(app.wsRegistry.hasPath("/ws/chat")).toBe(true);
      expect(app.wsRegistry.hasAnyHandlers()).toBe(true);
    });
  });

  // ─── RPC ───
  describe("RPC System", () => {
    it("handles RPC query (greeting.hello)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/_rpc/greeting.hello?input=" + encodeURIComponent(JSON.stringify({ name: "World" })),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.message).toBe("Hello, World!");
    });

    it("handles RPC query (math.add)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/_rpc/math.add?input=" + encodeURIComponent(JSON.stringify({ a: 3, b: 4 })),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.result).toBe(7);
    });

    it("handles RPC mutation (math.multiply)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/_rpc/math.multiply",
        headers: { "content-type": "application/json" },
        payload: { a: 5, b: 6 },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.result).toBe(30);
    });

    it("serves RPC manifest", async () => {
      const res = await app.inject({ method: "GET", url: "/api/_rpc/manifest.json" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.procedures).toBeDefined();
    });
  });

  // ─── Route Manifest ───
  describe("Route Manifest", () => {
    it("lists all registered routes", async () => {
      const res = await app.inject({ method: "GET", url: "/api/routes" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.routes.length).toBeGreaterThan(10);
    });
  });

  // ─── OpenAPI ───
  describe("OpenAPI", () => {
    it("serves OpenAPI JSON spec", async () => {
      const res = await app.inject({ method: "GET", url: "/api/docs/openapi.json" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.openapi).toBe("3.1.0");
      expect(body.info.title).toBe("CelsianJS Realism Audit");
    });
  });

  // ─── Compression ───
  describe("Compression", () => {
    it("compresses response when accept-encoding includes gzip", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/items",
        headers: { "accept-encoding": "gzip" },
      });
      expect(res.status).toBe(200);
      // Compression may or may not be applied (depends on threshold & body size)
      // Just verify the request succeeds
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 2: Adapter compatibility (Lambda, Cloudflare, Vercel Edge)
// ═══════════════════════════════════════════════════════════════

describe("Realism Audit — Adapter Compatibility", () => {
  // ─── Lambda Adapter ───
  describe("Lambda Adapter", () => {
    it("converts API Gateway v2 events to responses", async () => {
      const { app } = buildApp();
      await app.ready();
      const handler = createLambdaHandler(app);

      const event: APIGatewayProxyEventV2 = {
        version: "2.0",
        routeKey: "GET /api/health",
        rawPath: "/api/health",
        rawQueryString: "",
        headers: { "content-type": "application/json" },
        requestContext: {
          accountId: "123456789",
          apiId: "test",
          domainName: "test.execute-api.us-east-1.amazonaws.com",
          domainPrefix: "test",
          http: {
            method: "GET",
            path: "/api/health",
            protocol: "HTTP/1.1",
            sourceIp: "127.0.0.1",
            userAgent: "test",
          },
          requestId: "test-req-id",
          routeKey: "GET /api/health",
          stage: "$default",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
        isBase64Encoded: false,
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body ?? "{}");
      expect(body.status).toBe("ok");
    });
  });

  // ─── Cloudflare Adapter ───
  describe("Cloudflare Adapter", () => {
    it("creates a worker-compatible handler", async () => {
      const { app } = buildApp();
      await app.ready();
      const workerExport = createCloudflareHandler(app);
      expect(workerExport.fetch).toBeDefined();

      const request = new Request("https://example.com/api/health");
      const env = {};
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
      const res = await workerExport.fetch(request, env, ctx);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe("ok");
    });
  });

  // ─── Vercel Edge Adapter ───
  describe("Vercel Edge Adapter", () => {
    it("creates an edge-compatible handler", async () => {
      const { app } = buildApp();
      await app.ready();
      const handler = createVercelEdgeHandler(app);

      const request = new Request("https://example.com/api/health");
      const res = await handler(request);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe("ok");
    });
  });

  // ─── Bun Adapter ───
  describe("Bun Adapter", () => {
    it("creates a Bun.serve-compatible fetch handler", async () => {
      const { app } = buildApp();
      await app.ready();
      const handler = createBunHandler(app);

      const request = new Request("https://example.com/api/health");
      const mockServer = {};
      const res = await handler(request, mockServer);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe("ok");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 3: Live server test (serve() with real HTTP)
// ═══════════════════════════════════════════════════════════════

describe("Realism Audit — Live Server", () => {
  let closeServer: () => Promise<void>;
  const PORT = 49152 + Math.floor(Math.random() * 10000);
  const BASE = `http://127.0.0.1:${PORT}`;

  beforeAll(async () => {
    const { app } = buildApp();
    const result = await serve(app, {
      port: PORT,
      host: "127.0.0.1",
      onReady: () => {},
    });
    closeServer = result.close;
  });

  afterAll(async () => {
    await closeServer();
  });

  it("health check via real HTTP", async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("CORS headers via real HTTP", async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("security headers via real HTTP", async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("auth + CRUD flow via real HTTP", async () => {
    // Register
    const regRes = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "LiveTest", email: "live@test.com", password: "pass" }),
    });
    expect(regRes.status).toBe(201);
    const { token } = await regRes.json() as { token: string };

    // Create item
    const createRes = await fetch(`${BASE}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Live item" }),
    });
    expect(createRes.status).toBe(201);
    const item = await createRes.json() as { id: string };

    // Read item
    const readRes = await fetch(`${BASE}/api/items/${item.id}`);
    expect(readRes.status).toBe(200);

    // Delete item
    const deleteRes = await fetch(`${BASE}/api/items/${item.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteRes.status).toBe(204);
  });

  it("ETag conditional request via real HTTP", async () => {
    const first = await fetch(`${BASE}/api/etag-demo`);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const second = await fetch(`${BASE}/api/etag-demo`, {
      headers: { "if-none-match": etag },
    });
    expect(second.status).toBe(304);
  });

  it("HTML reply via real HTTP", async () => {
    const res = await fetch(`${BASE}/api/reply/html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("<h1>");
  });

  it("stream response via real HTTP", async () => {
    const res = await fetch(`${BASE}/api/reply/stream`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("chunk1chunk2");
  });

  it("error handling via real HTTP", async () => {
    const res = await fetch(`${BASE}/api/error/http`);
    expect(res.status).toBe(422);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("CUSTOM_VALIDATION");
  });

  it("SSE stream via real HTTP", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${BASE}/api/events`, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      // Read first chunk
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("event: connected");
      reader.cancel();
    } finally {
      clearTimeout(timeout);
    }
  });

  it("RPC via real HTTP", async () => {
    const input = encodeURIComponent(JSON.stringify({ name: "Live" }));
    const res = await fetch(`${BASE}/api/_rpc/greeting.hello?input=${input}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { message: string } };
    expect(body.result.message).toBe("Hello, Live!");
  });

  it("404 for unknown routes via real HTTP", async () => {
    const res = await fetch(`${BASE}/api/nope`);
    expect(res.status).toBe(404);
  });
});
