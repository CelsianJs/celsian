// Stress-test pass 6: Production readiness — adapter parity, streaming + errors,
// CORS preflight edge cases, cookie security, hook failures, complex lifecycle

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudflareHandler } from "../packages/adapter-cloudflare/src/index.js";
import { type APIGatewayProxyEventV2, createLambdaHandler } from "../packages/adapter-lambda/src/index.js";
import { createVercelCronHandler, createVercelEdgeHandler } from "../packages/adapter-vercel/src/index.js";
import { createResponseCache, createSessionManager, MemoryKVStore } from "../packages/cache/src/index.js";
import { compress } from "../packages/compress/src/index.js";
import { createApp } from "../packages/core/src/app.js";
import { parseCookies, serializeCookie } from "../packages/core/src/cookie.js";
import { HttpError, ValidationError } from "../packages/core/src/errors.js";
import { cors } from "../packages/core/src/plugins/cors.js";
import { security } from "../packages/core/src/plugins/security.js";
import { rateLimit } from "../packages/rate-limit/src/index.js";

// ─── Adapter Parity ─────────────────────────────────────────────

describe("Adapter parity", () => {
  async function buildTestApp() {
    const app = createApp();
    await app.register(security({ hsts: false }), { encapsulate: false });
    app.get("/json", () => ({ status: "ok" }));
    app.get("/text", (_req, reply) => reply.send("plain text"));
    app.post("/echo", (req) => ({ body: req.parsedBody }));
    app.get("/params/:id", (req) => ({ id: req.params.id }));
    app.get("/error", () => {
      throw new HttpError(422, "Validation failed");
    });
    return app;
  }

  describe("Vercel Edge adapter", () => {
    it("should handle GET returning JSON", async () => {
      const app = await buildTestApp();
      const handler = createVercelEdgeHandler(app);
      const res = await handler(new Request("http://localhost/json"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("should handle POST with body", async () => {
      const app = await buildTestApp();
      const handler = createVercelEdgeHandler(app);
      const res = await handler(
        new Request("http://localhost/echo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "val" }),
        }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).body).toEqual({ key: "val" });
    });

    it("should handle errors gracefully", async () => {
      const app = await buildTestApp();
      const handler = createVercelEdgeHandler(app);
      const res = await handler(new Request("http://localhost/error"));
      expect(res.status).toBe(422);
    });

    it("should handle 404", async () => {
      const app = await buildTestApp();
      const handler = createVercelEdgeHandler(app);
      const res = await handler(new Request("http://localhost/nope"));
      expect(res.status).toBe(404);
    });
  });

  describe("Vercel Cron handler", () => {
    it("should reject without CRON_SECRET", async () => {
      const app = createApp();
      app.get("/cron/cleanup", () => ({ cleaned: true }));
      const handler = createVercelCronHandler(app, "");
      const res = await handler(new Request("http://localhost/cron/cleanup"));
      expect(res.status).toBe(503);
    });

    it("should reject with wrong auth", async () => {
      const app = createApp();
      app.get("/cron/cleanup", () => ({ cleaned: true }));
      const handler = createVercelCronHandler(app, "my-secret");
      const res = await handler(
        new Request("http://localhost/cron/cleanup", {
          headers: { authorization: "Bearer wrong-secret" },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("should allow with correct auth", async () => {
      const app = createApp();
      app.get("/cron/cleanup", () => ({ cleaned: true }));
      const handler = createVercelCronHandler(app, "my-secret");
      const res = await handler(
        new Request("http://localhost/cron/cleanup", {
          headers: { authorization: "Bearer my-secret" },
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cleaned: true });
    });
  });

  describe("Cloudflare Workers adapter", () => {
    it("should pass request through to app.handle", async () => {
      const app = await buildTestApp();
      const worker = createCloudflareHandler(app);
      const mockCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

      const res = await worker.fetch(new Request("http://localhost/json"), {}, mockCtx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });

    it("should attach env and ctx to request", async () => {
      const app = createApp();
      app.get("/env", (req) => {
        return { hasEnv: "env" in req, hasCtx: "ctx" in req };
      });
      const worker = createCloudflareHandler(app);
      const mockCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

      const res = await worker.fetch(new Request("http://localhost/env"), { DB: "fake-binding" }, mockCtx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hasEnv: true, hasCtx: true });
    });

    it("should handle errors without crashing worker", async () => {
      const app = await buildTestApp();
      const worker = createCloudflareHandler(app);
      const mockCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

      const res = await worker.fetch(new Request("http://localhost/error"), {}, mockCtx);
      expect(res.status).toBe(422);
    });
  });

  describe("Lambda vs Edge parity", () => {
    it("same app should produce identical responses across adapters", async () => {
      const app = await buildTestApp();
      const edgeHandler = createVercelEdgeHandler(app);
      const lambdaHandler = createLambdaHandler(app);

      // Edge
      const edgeRes = await edgeHandler(new Request("http://localhost/params/42"));
      const edgeBody = await edgeRes.json();

      // Lambda
      const lambdaRes = await lambdaHandler({
        version: "2.0",
        routeKey: "$default",
        rawPath: "/params/42",
        rawQueryString: "",
        headers: { host: "localhost" },
        isBase64Encoded: false,
        requestContext: {
          http: { method: "GET", path: "/params/42", protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "test" },
          requestId: "r1",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      });
      const lambdaBody = JSON.parse(lambdaRes.body!);

      expect(edgeBody).toEqual(lambdaBody);
      expect(edgeRes.status).toBe(lambdaRes.statusCode);
    });
  });
});

// ─── CORS Edge Cases ────────────────────────────────────────────

describe("CORS edge cases", () => {
  it("should reject wildcardorigin + credentials at registration", () => {
    const app = createApp();
    expect(() => cors({ origin: "*", credentials: true })).toThrow(/credentials/);
  });

  it("preflight should reflect request headers when allowedHeaders not set", async () => {
    const app = createApp();
    await app.register(cors({ origin: "https://app.com" }), { encapsulate: false });
    app.get("/api", () => ({}));

    const res = await app.inject({
      method: "OPTIONS",
      url: "/api",
      headers: {
        origin: "https://app.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-custom-header, authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("x-custom-header, authorization");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.com");
  });

  it("preflight from disallowed origin should not set CORS headers", async () => {
    const app = createApp();
    await app.register(cors({ origin: "https://allowed.com" }), { encapsulate: false });
    app.get("/api", () => ({}));

    const res = await app.inject({
      method: "OPTIONS",
      url: "/api",
      headers: {
        origin: "https://evil.com",
        "access-control-request-method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("should support array of allowed origins", async () => {
    const app = createApp();
    await app.register(cors({ origin: ["https://a.com", "https://b.com"], credentials: true }), { encapsulate: false });
    app.get("/api", () => ({}));

    const resA = await app.inject({
      url: "/api",
      headers: { origin: "https://a.com" },
    });
    expect(resA.headers.get("access-control-allow-origin")).toBe("https://a.com");

    const resB = await app.inject({
      url: "/api",
      headers: { origin: "https://b.com" },
    });
    expect(resB.headers.get("access-control-allow-origin")).toBe("https://b.com");

    const resC = await app.inject({
      url: "/api",
      headers: { origin: "https://evil.com" },
    });
    expect(resC.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("should support function origin validator", async () => {
    const app = createApp();
    await app.register(cors({ origin: (o) => o.endsWith(".mycompany.com") }), { encapsulate: false });
    app.get("/api", () => ({}));

    const good = await app.inject({
      url: "/api",
      headers: { origin: "https://dashboard.mycompany.com" },
    });
    expect(good.headers.get("access-control-allow-origin")).toBe("https://dashboard.mycompany.com");

    const bad = await app.inject({
      url: "/api",
      headers: { origin: "https://evil.com" },
    });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("maxAge should appear in preflight response", async () => {
    const app = createApp();
    await app.register(cors({ origin: "*", maxAge: 86400 }), { encapsulate: false });
    app.get("/api", () => ({}));

    const res = await app.inject({
      method: "OPTIONS",
      url: "/api",
      headers: {
        origin: "https://any.com",
        "access-control-request-method": "GET",
      },
    });
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  it("exposedHeaders should appear on actual requests", async () => {
    const app = createApp();
    await app.register(cors({ origin: "*", exposedHeaders: ["x-request-id", "x-total-count"] }), {
      encapsulate: false,
    });
    app.get("/api", () => ({}));

    const res = await app.inject({
      url: "/api",
      headers: { origin: "https://any.com" },
    });
    expect(res.headers.get("access-control-expose-headers")).toBe("x-request-id, x-total-count");
  });
});

// ─── Cookie Security ────────────────────────────────────────────

describe("Cookie security", () => {
  it("parseCookies should block prototype pollution keys", () => {
    const result = parseCookies("__proto__=evil; constructor=bad; name=good");
    expect(result.__proto__).toBeUndefined();
    expect(result.constructor).toBeUndefined();
    expect(result.name).toBe("good");
  });

  it("parseCookies should handle empty and malformed headers", () => {
    expect(parseCookies("")).toEqual({});
    expect(parseCookies(";;;")).toEqual({});
    expect(parseCookies("noequals")).toEqual({});
    expect(parseCookies("a=1; b=2; c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("parseCookies should decode URI-encoded values", () => {
    const result = parseCookies("name=hello%20world; path=%2Ftest");
    expect(result.name).toBe("hello world");
    expect(result.path).toBe("/test");
  });

  it("serializeCookie should set secure defaults", () => {
    const cookie = serializeCookie("session", "abc123", { path: "/" });
    expect(cookie).toContain("session=abc123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("serializeCookie should encode special characters", () => {
    const cookie = serializeCookie("data", "hello world; drop table");
    expect(cookie).toContain("data=hello%20world%3B%20drop%20table");
  });

  it("reply.header() should strip CRLF (header injection prevention)", async () => {
    const app = createApp();
    app.get("/inject", (_req, reply) => {
      reply.header("x-custom", "value\r\nX-Injected: evil");
      return reply.json({ ok: true });
    });

    const res = await app.inject({ url: "/inject" });
    expect(res.headers.get("x-custom")).toBe("valueX-Injected: evil");
    expect(res.headers.get("x-injected")).toBeNull();
  });

  it("reply.redirect() should reject protocol-relative URLs", async () => {
    const app = createApp();
    app.get("/redir", (_req, reply) => reply.redirect("//evil.com/phish"));

    const res = await app.inject({ url: "/redir" });
    // Should not redirect — should error
    expect(res.status).toBe(500);
  });

  it("reply.sendFile() path traversal with encoded dots should be blocked", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => {
      return reply.sendFile("..%2F..%2F..%2Fetc%2Fpasswd", { root: process.cwd() + "/packages" });
    });

    const res = await app.inject({ url: "/file" });
    // The path "..%2F..." is passed as-is to sendFile, but resolve() handles it
    // Should get 403 (traversal) or 404 (not found)
    expect([403, 404]).toContain(res.status);
  });
});

// ─── Streaming + Error Interactions ─────────────────────────────

describe("Streaming + error interactions", () => {
  it("reply.stream() should work with ReadableStream that errors", async () => {
    const app = createApp();
    app.get("/broken-stream", (_req, reply) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("start"));
          controller.error(new Error("stream failed"));
        },
      });
      return reply.stream(stream);
    });

    const res = await app.inject({ url: "/broken-stream" });
    // The response is created before the error — status 200 was already set
    expect(res.status).toBe(200);
  });

  it("handler returning ReadableStream Response should work", async () => {
    const app = createApp();
    app.get("/chunks", () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("a"));
          controller.enqueue(encoder.encode("b"));
          controller.enqueue(encoder.encode("c"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/plain" },
      });
    });

    const res = await app.inject({ url: "/chunks" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc");
  });

  it("large JSON response auto-serialization should work", async () => {
    const app = createApp();
    const bigArray = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `Item ${i}`,
      tags: ["a", "b", "c"],
    }));
    app.get("/big", () => bigArray);

    const res = await app.inject({ url: "/big" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1000);
    expect(data[999].id).toBe(999);
  });
});

// ─── Hook Failure Resilience ────────────────────────────────────

describe("Hook failure resilience", () => {
  it("error in onRequest hook should trigger error handling", async () => {
    const app = createApp();
    app.addHook("onRequest", () => {
      throw new HttpError(503, "Maintenance mode");
    });
    app.get("/test", () => ({ should: "not reach" }));

    const res = await app.inject({ url: "/test" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Maintenance mode");
  });

  it("error in preHandler should not crash app", async () => {
    const app = createApp();
    app.get(
      "/guarded",
      {
        preHandler: [
          () => {
            throw new HttpError(401, "Token expired");
          },
        ],
      },
      () => ({ secret: "data" }),
    );

    const res = await app.inject({ url: "/guarded" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Token expired");
  });

  it("non-Error throw in hook should be wrapped", async () => {
    const app = createApp();
    app.addHook("onRequest", () => {
      throw "string error";
    });
    app.get("/test", () => ({}));

    const res = await app.inject({ url: "/test" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("non-Error value");
  });

  it("async hook error should be caught", async () => {
    const app = createApp();
    app.addHook("onRequest", async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new HttpError(429, "Rate limit in hook");
    });
    app.get("/test", () => ({}));

    const res = await app.inject({ url: "/test" });
    expect(res.status).toBe(429);
  });

  it("onSend hook error should not prevent response", async () => {
    const app = createApp();
    app.addHook("onSend", () => {
      throw new Error("onSend broke");
    });
    app.get("/test", () => ({ ok: true }));

    // onSend errors should be caught at the app level
    // The response should still be returned (possibly without onSend modifications)
    const res = await app.inject({ url: "/test" });
    // Should get some response (either 200 from handler or 500 from error)
    expect([200, 500]).toContain(res.status);
  });
});

// ─── Complex Multi-Plugin SaaS Pattern ──────────────────────────

describe("Production SaaS pattern", () => {
  function buildProductionApp() {
    const app = createApp({ prefix: "/api/v1" });

    // Layer 1: Security headers
    app.register(security(), { encapsulate: false });

    // Layer 2: CORS
    app.register(
      cors({
        origin: ["https://app.production.com", "http://localhost:3000"],
        credentials: true,
        exposedHeaders: ["x-request-id", "x-ratelimit-remaining"],
      }),
      { encapsulate: false },
    );

    // Layer 3: Rate limiting
    app.register(
      rateLimit({
        max: 100,
        window: 60_000,
        keyGenerator: (req) => req.headers.get("x-api-key") ?? "anonymous",
      }),
      { encapsulate: false },
    );

    // Request ID middleware
    let reqCounter = 0;
    app.addHook("onSend", (_req, reply) => {
      reply.header("x-request-id", `req-${++reqCounter}`);
    });

    // Public endpoints
    app.get("/health", () => ({ status: "healthy", version: "1.0.0" }));

    // Authenticated section
    app.register(
      async (authenticated) => {
        authenticated.addHook("onRequest", (req, reply) => {
          const apiKey = req.headers.get("x-api-key");
          if (!apiKey || apiKey === "invalid") {
            return reply.status(401).json({ error: "Invalid API key" });
          }
        });

        authenticated.get("/me", (req) => ({
          apiKey: req.headers.get("x-api-key"),
          authenticated: true,
        }));

        authenticated.post("/items", (req, reply) => {
          const body = req.parsedBody as { name?: string } | null;
          if (!body?.name) {
            throw new ValidationError([{ message: "name is required", path: ["name"] }]);
          }
          reply.status(201);
          return { id: Date.now(), name: body.name };
        });

        authenticated.delete("/items/:id", (req) => ({
          deleted: true,
          id: req.params.id,
        }));
      },
      { prefix: "/resources", encapsulate: true },
    );

    return app;
  }

  it("health endpoint has all cross-cutting headers", async () => {
    const app = buildProductionApp();
    const res = await app.inject({
      url: "/api/v1/health",
      headers: { origin: "https://app.production.com", "x-api-key": "test-key" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.production.com");
    expect(res.headers.get("x-ratelimit-limit")).toBe("100");
    expect(res.headers.get("x-request-id")).toMatch(/^req-\d+$/);
    expect(await res.json()).toEqual({ status: "healthy", version: "1.0.0" });
  });

  it("authenticated endpoint rejects without API key", async () => {
    const app = buildProductionApp();
    const res = await app.inject({ url: "/api/v1/resources/me" });
    expect(res.status).toBe(401);
  });

  it("authenticated endpoint works with valid API key", async () => {
    const app = buildProductionApp();
    const res = await app.inject({
      url: "/api/v1/resources/me",
      headers: { "x-api-key": "valid-key-123" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).authenticated).toBe(true);
  });

  it("POST validation error returns 400 with issues", async () => {
    const app = buildProductionApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/resources/items",
      headers: { "x-api-key": "valid-key" },
      payload: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.issues[0].path).toEqual(["name"]);
  });

  it("successful POST returns 201", async () => {
    const app = buildProductionApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/resources/items",
      headers: { "x-api-key": "valid-key" },
      payload: { name: "Widget" },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).name).toBe("Widget");
  });

  it("DELETE with params works", async () => {
    const app = buildProductionApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/resources/items/42",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, id: "42" });
  });

  it("rate limit headers accumulate with security headers", async () => {
    const app = buildProductionApp();
    const res = await app.inject({
      url: "/api/v1/health",
      headers: { "x-api-key": "test" },
    });
    // Security
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // Rate limit
    expect(res.headers.get("x-ratelimit-remaining")).toBe("99");
    // Custom
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("preflight CORS works with all plugins loaded", async () => {
    const app = buildProductionApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/resources/items",
      headers: {
        origin: "https://app.production.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-api-key",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.production.com");
    expect(res.headers.get("access-control-allow-headers")).toContain("x-api-key");
  });

  it("HEAD requests work correctly with all plugins", async () => {
    const app = buildProductionApp();
    const res = await app.inject({
      method: "HEAD",
      url: "/api/v1/health",
      headers: { "x-api-key": "test" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// ─── Vercel Edge + Cloudflare parity with plugins ───────────────

describe("Edge adapter + plugins", () => {
  it("Vercel Edge should preserve security headers", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
    app.get("/data", () => ({ edge: true }));

    const handler = createVercelEdgeHandler(app);
    const res = await handler(new Request("http://localhost/data"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("Cloudflare adapter should preserve CORS headers", async () => {
    const app = createApp();
    await app.register(cors({ origin: "*" }), { encapsulate: false });
    app.get("/api", () => ({ cf: true }));

    const worker = createCloudflareHandler(app);
    const res = await worker.fetch(
      new Request("http://localhost/api", { headers: { origin: "https://any.com" } }),
      {},
      { waitUntil: () => {}, passThroughOnException: () => {} },
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

// ─── App lifecycle edge cases ───────────────────────────────────

describe("App lifecycle", () => {
  it("app.ready() should be idempotent", async () => {
    const app = createApp();
    let pluginCalls = 0;
    await app.register(() => {
      pluginCalls++;
    });

    await app.ready();
    await app.ready();
    await app.ready();
    // Plugin should only run once during registration, ready() is safe to call multiple times
    expect(pluginCalls).toBe(1);
  });

  it("routes registered after ready() should still work", async () => {
    const app = createApp();
    await app.ready();
    app.get("/late", () => ({ late: true }));

    const res = await app.inject({ url: "/late" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ late: true });
  });

  it("inject() should implicitly call ready()", async () => {
    const app = createApp();
    app.get("/auto", () => ({ auto: true }));
    // Don't call ready() — inject should handle it
    const res = await app.inject({ url: "/auto" });
    expect(res.status).toBe(200);
  });

  it("multiple apps should be fully independent", async () => {
    const app1 = createApp();
    const app2 = createApp();

    app1.addHook("onSend", (_req, reply) => {
      reply.header("x-app", "1");
    });

    app1.get("/test", () => ({ app: 1 }));
    app2.get("/test", () => ({ app: 2 }));

    const res1 = await app1.inject({ url: "/test" });
    const res2 = await app2.inject({ url: "/test" });

    expect(await res1.json()).toEqual({ app: 1 });
    expect(await res2.json()).toEqual({ app: 2 });
    expect(res1.headers.get("x-app")).toBe("1");
    expect(res2.headers.get("x-app")).toBeNull();
  });
});

// ─── No h() calls verification ──────────────────────────────────

describe("Zero low-level internals in userland", () => {
  it("complete REST API requires no framework internals", async () => {
    // This demonstrates the full developer-facing API surface
    const app = createApp({ prefix: "/shop" });

    // Plugins — clean declarative registration
    await app.register(security({ contentSecurityPolicy: "default-src 'self'" }), { encapsulate: false });
    await app.register(cors({ origin: "https://shop.example.com", credentials: true }), { encapsulate: false });

    // Simple data layer (no ORM internals)
    const products = [
      { id: "p1", name: "Shirt", price: 29.99, stock: 10 },
      { id: "p2", name: "Pants", price: 49.99, stock: 5 },
    ];

    // Routes — return values auto-serialize, no manual Response construction needed
    app.get("/products", (req) => {
      const category = req.query.category;
      return category ? products.filter((p) => p.name.toLowerCase().includes(category)) : products;
    });

    app.get("/products/:id", (req, reply) => {
      const product = products.find((p) => p.id === req.params.id);
      if (!product) return reply.notFound("Product not found");
      return product;
    });

    app.post("/orders", (req, reply) => {
      const body = req.parsedBody as { productId: string; qty: number };
      const product = products.find((p) => p.id === body.productId);
      if (!product) throw new HttpError(400, "Invalid product");
      if (product.stock < body.qty) throw new HttpError(409, "Insufficient stock");
      product.stock -= body.qty;
      reply.status(201);
      return { orderId: `ord-${Date.now()}`, product: product.name, qty: body.qty };
    });

    // Test the full surface
    const listRes = await app.inject({
      url: "/shop/products",
      headers: { origin: "https://shop.example.com" },
    });
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(listRes.headers.get("access-control-allow-origin")).toBe("https://shop.example.com");
    expect(await listRes.json()).toHaveLength(2);

    const getRes = await app.inject({ url: "/shop/products/p1" });
    expect((await getRes.json()).name).toBe("Shirt");

    const orderRes = await app.inject({
      method: "POST",
      url: "/shop/orders",
      payload: { productId: "p1", qty: 2 },
    });
    expect(orderRes.status).toBe(201);
    expect((await orderRes.json()).qty).toBe(2);

    const stockRes = await app.inject({ url: "/shop/products/p1" });
    expect((await stockRes.json()).stock).toBe(8);
  });
});
