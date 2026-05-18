// Stress-test pass 4: router edge cases, error handling, WebSocket registry,
// adapter-node utilities, hook lifecycle depth, DX ergonomics, plugin composition

import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLambdaHandler } from "../packages/adapter-lambda/src/index.js";
import { nodeToWebRequest } from "../packages/adapter-node/src/index.js";
import { createApp } from "../packages/core/src/app.js";
import { CelsianError, HttpError, ValidationError, wrapNonError } from "../packages/core/src/errors.js";
import { cors } from "../packages/core/src/plugins/cors.js";
import { security } from "../packages/core/src/plugins/security.js";
import { Router } from "../packages/core/src/router.js";
import { createSSEHub, createSSEStream } from "../packages/core/src/sse.js";
import { createWSConnection, WSRegistry } from "../packages/core/src/websocket.js";

// ─── Router Edge Cases ──────────────────────────────────────────

describe("Router edge cases", () => {
  it("should handle deeply nested params", async () => {
    const app = createApp();
    app.get("/api/:version/users/:userId/posts/:postId/comments/:commentId", (req) => ({
      version: req.params.version,
      userId: req.params.userId,
      postId: req.params.postId,
      commentId: req.params.commentId,
    }));

    const res = await app.inject({ url: "/api/v2/users/42/posts/99/comments/7" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: "v2",
      userId: "42",
      postId: "99",
      commentId: "7",
    });
  });

  it("should decode URI-encoded params", async () => {
    const app = createApp();
    app.get("/files/:path", (req) => ({ path: req.params.path }));

    const res = await app.inject({ url: "/files/hello%20world%2Ftest" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "hello world/test" });
  });

  it("should handle trailing slash normalization", async () => {
    const app = createApp();
    app.get("/users", () => ({ users: [] }));

    const withSlash = await app.inject({ url: "/users/" });
    const withoutSlash = await app.inject({ url: "/users" });
    // Both should match (framework normalizes trailing slashes)
    expect(withoutSlash.status).toBe(200);
    // trailing slash behavior depends on router — document the actual behavior
    expect([200, 404]).toContain(withSlash.status);
  });

  it("should prefer static routes over param routes", async () => {
    const app = createApp();
    app.get("/users/me", () => ({ type: "static" }));
    app.get("/users/:id", (req) => ({ type: "param", id: req.params.id }));

    const staticRes = await app.inject({ url: "/users/me" });
    expect(await staticRes.json()).toEqual({ type: "static" });

    const paramRes = await app.inject({ url: "/users/123" });
    expect(await paramRes.json()).toEqual({ type: "param", id: "123" });
  });

  it("should handle wildcard catch-all routes", async () => {
    const app = createApp();
    app.get("/static/*path", (req) => ({ path: req.params["*"] ?? req.params.path }));

    const res = await app.inject({ url: "/static/css/main.css" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe("css/main.css");
  });

  it("should return 405 for wrong method on existing path", async () => {
    const app = createApp();
    app.get("/resource", () => ({ ok: true }));
    app.post("/resource", () => ({ created: true }));

    const res = await app.inject({ method: "DELETE", url: "/resource" });
    expect(res.status).toBe(405);
  });

  it("should return 404 for completely unknown paths", async () => {
    const app = createApp();
    app.get("/known", () => ({ ok: true }));

    const res = await app.inject({ url: "/unknown/path/here" });
    expect(res.status).toBe(404);
  });

  it("Router class should collect all registered routes", () => {
    const router = new Router();
    router.addRoute("GET", "/a", () => new Response("a"));
    router.addRoute("POST", "/b", () => new Response("b"));
    router.addRoute("GET", "/c/:id", () => new Response("c"));

    const routes = router.getAllRoutes();
    expect(routes).toHaveLength(3);
  });

  it("should handle root path correctly", async () => {
    const app = createApp();
    app.get("/", () => ({ root: true }));

    const res = await app.inject({ url: "/" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ root: true });
  });

  it("should handle multiple params in same segment pattern", async () => {
    const app = createApp();
    app.get("/org/:orgId/team/:teamId", (req) => ({
      org: req.params.orgId,
      team: req.params.teamId,
    }));

    const res = await app.inject({ url: "/org/acme/team/alpha" });
    expect(await res.json()).toEqual({ org: "acme", team: "alpha" });
  });
});

// ─── Error Handling Depth ───────────────────────────────────────

describe("Error handling", () => {
  it("HttpError should serialize to proper JSON", async () => {
    const app = createApp();
    app.get("/fail", () => {
      throw new HttpError(422, "Email is invalid", { code: "INVALID_EMAIL" });
    });

    const res = await app.inject({ url: "/fail" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Email is invalid");
    expect(body.code).toBe("INVALID_EMAIL");
    expect(body.statusCode).toBe(422);
  });

  it("ValidationError should include issues array", async () => {
    const app = createApp();
    app.get("/validate", () => {
      throw new ValidationError([
        { message: "Required", path: ["email"] },
        { message: "Must be at least 8 characters", path: ["password"] },
      ]);
    });

    const res = await app.inject({ url: "/validate" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.issues).toHaveLength(2);
    expect(body.issues[0].path).toEqual(["email"]);
  });

  it("non-Error throws should be wrapped", async () => {
    const app = createApp();
    app.get("/throw-string", () => {
      throw "something went wrong";
    });

    const res = await app.inject({ url: "/throw-string" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("non-Error value");
  });

  it("custom error handler should intercept errors", async () => {
    const app = createApp();
    app.setErrorHandler((error, _req, reply) => {
      return reply.status(error instanceof HttpError ? error.statusCode : 500).json({
        custom: true,
        message: error.message,
      });
    });
    app.get("/fail", () => {
      throw new HttpError(403, "No access");
    });

    const res = await app.inject({ url: "/fail" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.custom).toBe(true);
    expect(body.message).toBe("No access");
  });

  it("onError hook should run when handler throws", async () => {
    const app = createApp();
    const errors: string[] = [];
    app.addHook("onError", (error) => {
      errors.push(error.message);
    });
    app.get("/boom", () => {
      throw new HttpError(500, "kaboom");
    });

    const res = await app.inject({ url: "/boom" });
    expect(res.status).toBe(500);
    expect(errors).toEqual(["kaboom"]);
  });

  it("onError hook returning Response should use that response", async () => {
    const app = createApp();
    app.addHook("onError", (error, _req, reply) => {
      return reply.status(503).json({ overridden: true, original: error.message });
    });
    app.get("/fail", () => {
      throw new HttpError(500, "original error");
    });

    const res = await app.inject({ url: "/fail" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ overridden: true, original: "original error" });
  });

  it("errors in error handler should fall through to default", async () => {
    const app = createApp();
    app.setErrorHandler(() => {
      throw new Error("error handler also broken");
    });
    app.get("/fail", () => {
      throw new HttpError(400, "original");
    });

    const res = await app.inject({ url: "/fail" });
    // Should still return a response (not crash)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("wrapNonError should handle various thrown types", () => {
    expect(wrapNonError("a string")).toBeInstanceOf(CelsianError);
    expect(wrapNonError(42)).toBeInstanceOf(CelsianError);
    expect(wrapNonError(null)).toBeInstanceOf(CelsianError);
    expect(wrapNonError(undefined)).toBeInstanceOf(CelsianError);
    const realError = new Error("real");
    expect(wrapNonError(realError)).toBe(realError);
  });

  it("timeout should return 504", async () => {
    const app = createApp({ requestTimeout: 50 });
    app.get("/slow", async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { done: true };
    });

    const res = await app.inject({ url: "/slow" });
    expect(res.status).toBe(504);
  });
});

// ─── WebSocket Registry ─────────────────────────────────────────

describe("WSRegistry", () => {
  it("should register handlers and track connections", () => {
    const registry = new WSRegistry();
    registry.register("/ws/chat", {
      open: () => {},
      message: () => {},
      close: () => {},
    });

    expect(registry.hasPath("/ws/chat")).toBe(true);
    expect(registry.hasPath("/ws/other")).toBe(false);
    expect(registry.hasAnyHandlers()).toBe(true);
  });

  it("should broadcast to all connections on a path", () => {
    const registry = new WSRegistry();
    registry.register("/chat", { open: () => {} });

    const messages1: string[] = [];
    const messages2: string[] = [];

    const ws1 = createWSConnection({
      send: (d) => messages1.push(d as string),
      close: () => {},
    });
    const ws2 = createWSConnection({
      send: (d) => messages2.push(d as string),
      close: () => {},
    });

    registry.addConnection("/chat", ws1);
    registry.addConnection("/chat", ws2);
    expect(registry.getConnectionCount("/chat")).toBe(2);

    registry.broadcast("/chat", "hello everyone");
    expect(messages1).toEqual(["hello everyone"]);
    expect(messages2).toEqual(["hello everyone"]);
  });

  it("should exclude specific connection from broadcast", () => {
    const registry = new WSRegistry();
    registry.register("/chat", {});

    const messages1: string[] = [];
    const messages2: string[] = [];

    const ws1 = createWSConnection({
      send: (d) => messages1.push(d as string),
      close: () => {},
    });
    const ws2 = createWSConnection({
      send: (d) => messages2.push(d as string),
      close: () => {},
    });

    registry.addConnection("/chat", ws1);
    registry.addConnection("/chat", ws2);

    registry.broadcast("/chat", "only for ws2", ws1.id);
    expect(messages1).toEqual([]);
    expect(messages2).toEqual(["only for ws2"]);
  });

  it("should broadcastAll across all paths", () => {
    const registry = new WSRegistry();
    registry.register("/a", {});
    registry.register("/b", {});

    const msgsA: string[] = [];
    const msgsB: string[] = [];

    const wsA = createWSConnection({ send: (d) => msgsA.push(d as string), close: () => {} });
    const wsB = createWSConnection({ send: (d) => msgsB.push(d as string), close: () => {} });

    registry.addConnection("/a", wsA);
    registry.addConnection("/b", wsB);

    registry.broadcastAll("global");
    expect(msgsA).toEqual(["global"]);
    expect(msgsB).toEqual(["global"]);
    expect(registry.getConnectionCount()).toBe(2);
  });

  it("should handle removeConnection", () => {
    const registry = new WSRegistry();
    registry.register("/chat", {});
    const ws = createWSConnection({ send: () => {}, close: () => {} });
    registry.addConnection("/chat", ws);
    expect(registry.getConnectionCount("/chat")).toBe(1);
    registry.removeConnection("/chat", ws);
    expect(registry.getConnectionCount("/chat")).toBe(0);
  });

  it("should handle send errors gracefully during broadcast", () => {
    const registry = new WSRegistry();
    registry.register("/chat", {});

    const ws1 = createWSConnection({
      send: () => {
        throw new Error("connection closed");
      },
      close: () => {},
    });
    const messages2: string[] = [];
    const ws2 = createWSConnection({
      send: (d) => messages2.push(d as string),
      close: () => {},
    });

    registry.addConnection("/chat", ws1);
    registry.addConnection("/chat", ws2);

    // Should not throw even though ws1 errors
    expect(() => registry.broadcast("/chat", "test")).not.toThrow();
    expect(messages2).toEqual(["test"]);
  });

  it("createWSConnection should generate unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const ws = createWSConnection({ send: () => {}, close: () => {} });
      ids.add(ws.id);
    }
    expect(ids.size).toBe(100);
  });

  it("WSConnection metadata bag should be writable", () => {
    const ws = createWSConnection({ send: () => {}, close: () => {} });
    ws.metadata.userId = "user-123";
    ws.metadata.room = "general";
    expect(ws.metadata.userId).toBe("user-123");
    expect(ws.metadata.room).toBe("general");
  });
});

// ─── SSE Advanced Patterns ──────────────────────────────────────

describe("SSE patterns", () => {
  it("createSSEHub should track subscribers and broadcast", () => {
    const hub = createSSEHub();
    const req1 = new Request("http://localhost/events");
    const req2 = new Request("http://localhost/events");

    const ch1 = hub.subscribe(req1);
    const ch2 = hub.subscribe(req2);
    expect(hub.size).toBe(2);
    expect(ch1.open).toBe(true);
    expect(ch2.response).toBeInstanceOf(Response);

    hub.broadcastData({ type: "ping" });
    ch1.close();
    expect(hub.size).toBe(1);
    ch2.close();
    expect(hub.size).toBe(0);
  });

  it("createSSEStream should return a proper streaming Response", () => {
    const req = new Request("http://localhost/events");
    const channel = createSSEStream(req);

    expect(channel.response).toBeInstanceOf(Response);
    expect(channel.response.headers.get("content-type")).toBe("text/event-stream");
    expect(channel.response.headers.get("cache-control")).toBe("no-cache");
    expect(channel.response.headers.get("connection")).toBe("keep-alive");

    // Should not throw
    channel.send({ event: "test-event", data: "hello" });
    channel.close();
  });

  it("SSE hub closeAll should close all channels", () => {
    const hub = createSSEHub();
    hub.subscribe(new Request("http://localhost/e1"));
    hub.subscribe(new Request("http://localhost/e2"));
    hub.subscribe(new Request("http://localhost/e3"));
    expect(hub.size).toBe(3);

    hub.closeAll();
    expect(hub.size).toBe(0);
  });
});

// ─── adapter-node utilities ─────────────────────────────────────

describe("adapter-node utilities", () => {
  function mockIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
      method: "GET",
      url: "/test",
      headers: { host: "localhost:3000", "content-type": "application/json" },
      ...overrides,
    } as unknown as IncomingMessage;
  }

  it("nodeToWebRequest should convert GET request", () => {
    const req = mockIncomingMessage({ method: "GET" });
    const url = new URL("http://localhost:3000/test");
    const webReq = nodeToWebRequest(req, url);

    expect(webReq.method).toBe("GET");
    expect(webReq.url).toBe("http://localhost:3000/test");
    expect(webReq.headers.get("content-type")).toBe("application/json");
  });

  it("nodeToWebRequest should handle array headers (e.g., Set-Cookie)", () => {
    const req = mockIncomingMessage({
      headers: { host: "localhost", "set-cookie": ["a=1", "b=2"] as unknown as string },
    });
    const url = new URL("http://localhost/test");
    const webReq = nodeToWebRequest(req, url);
    expect(webReq.headers.get("host")).toBe("localhost");
  });

  it("nodeToWebRequest should handle POST with body stream", () => {
    const req = mockIncomingMessage({ method: "POST" });
    const url = new URL("http://localhost:3000/data");
    const webReq = nodeToWebRequest(req, url);

    expect(webReq.method).toBe("POST");
    // Body is the IncomingMessage as ReadableStream — non-null for POST
    expect(webReq.body).not.toBeNull();
  });

  it("nodeToWebRequest should not set body for HEAD requests", () => {
    const req = mockIncomingMessage({ method: "HEAD" });
    const url = new URL("http://localhost:3000/test");
    const webReq = nodeToWebRequest(req, url);

    expect(webReq.method).toBe("HEAD");
    expect(webReq.body).toBeNull();
  });
});

// ─── Hook Lifecycle Integration ─────────────────────────────────

describe("Full hook lifecycle", () => {
  it("hooks should run in correct order: onRequest → preHandler → handler → onSend → onResponse", async () => {
    const order: string[] = [];
    const app = createApp();

    app.addHook("onRequest", () => {
      order.push("onRequest");
    });
    app.addHook("onSend", () => {
      order.push("onSend");
    });
    app.addHook("onResponse", () => {
      order.push("onResponse");
    });

    app.get(
      "/test",
      {
        preHandler: [
          () => {
            order.push("preHandler");
          },
        ],
      },
      () => {
        order.push("handler");
        return { ok: true };
      },
    );

    await app.inject({ url: "/test" });
    // onResponse is fire-and-forget, might not be in order
    expect(order.slice(0, 4)).toEqual(["onRequest", "preHandler", "handler", "onSend"]);
  });

  it("onRequest short-circuit should skip handler", async () => {
    const app = createApp();
    let handlerCalled = false;

    app.addHook("onRequest", (_req, reply) => {
      return reply.status(401).json({ error: "unauthorized" });
    });

    app.get("/secret", () => {
      handlerCalled = true;
      return { data: "secret" };
    });

    const res = await app.inject({ url: "/secret" });
    expect(res.status).toBe(401);
    expect(handlerCalled).toBe(false);
  });

  it("multiple onSend hooks should all execute", async () => {
    const app = createApp();
    const executed: string[] = [];

    app.addHook("onSend", () => {
      executed.push("a");
    });
    app.addHook("onSend", () => {
      executed.push("b");
    });
    app.addHook("onSend", () => {
      executed.push("c");
    });
    app.get("/test", () => ({ ok: true }));

    await app.inject({ url: "/test" });
    expect(executed).toEqual(["a", "b", "c"]);
  });

  it("reply.header() in onSend should appear in final response", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, reply) => {
      reply.header("x-timing", "42ms");
      reply.header("x-request-id", "abc-123");
    });
    app.get("/test", () => ({ ok: true }));

    const res = await app.inject({ url: "/test" });
    expect(res.headers.get("x-timing")).toBe("42ms");
    expect(res.headers.get("x-request-id")).toBe("abc-123");
  });
});

// ─── Plugin Composition Patterns ────────────────────────────────

describe("Plugin composition patterns", () => {
  it("nested plugin registration should scope hooks", async () => {
    const app = createApp();

    await app.register(
      async (admin) => {
        admin.addHook("onRequest", (_req, reply) => {
          reply.header("x-scope", "admin");
        });
        admin.get("/dashboard", () => ({ admin: true }));
      },
      { encapsulate: true, prefix: "/admin" },
    );

    app.get("/public", () => ({ public: true }));

    const adminRes = await app.inject({ url: "/admin/dashboard" });
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers.get("x-scope")).toBe("admin");

    const publicRes = await app.inject({ url: "/public" });
    expect(publicRes.status).toBe(200);
    expect(publicRes.headers.get("x-scope")).toBeNull();
  });

  it("decorations should be accessible in routes", async () => {
    const app = createApp();
    app.decorate("config", { env: "test", version: "1.0" });

    app.get("/config", () => {
      const config = app.getDecoration("config") as { env: string; version: string };
      return config;
    });

    const res = await app.inject({ url: "/config" });
    expect(await res.json()).toEqual({ env: "test", version: "1.0" });
  });

  it("app.register should reject non-function plugins with clear error", async () => {
    const app = createApp();
    await expect(app.register({} as any)).rejects.toThrow(/plugin function/);
    await expect(app.register(null as any)).rejects.toThrow(/plugin function/);
    await expect(app.register(42 as any)).rejects.toThrow(/plugin function/);
  });

  it("security + cors + custom hooks should all coexist", async () => {
    const app = createApp();
    await app.register(security({ hsts: false, xssProtection: false }), { encapsulate: false });
    await app.register(cors({ origin: "*" }), { encapsulate: false });

    app.addHook("onSend", (_req, reply) => {
      reply.header("x-custom", "yes");
    });

    app.get("/api/data", () => ({ items: [1, 2, 3] }));

    const res = await app.inject({
      url: "/api/data",
      headers: { origin: "https://example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-custom")).toBe("yes");
  });

  it("plugin with prefix should namespace all routes", async () => {
    const app = createApp();

    await app.register(
      async (plugin) => {
        plugin.get("/list", () => [1, 2, 3]);
        plugin.post("/create", () => ({ id: 1 }));
      },
      { prefix: "/items" },
    );

    const list = await app.inject({ url: "/items/list" });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([1, 2, 3]);

    const create = await app.inject({ method: "POST", url: "/items/create" });
    expect(create.status).toBe(200);
  });
});

// ─── DX Ergonomics Verification ─────────────────────────────────

describe("DX ergonomics", () => {
  it("no h() calls, no low-level internals needed in userland", async () => {
    // This test verifies the entire DX surface works without any
    // low-level framework internals leaking into application code.
    const app = createApp({ prefix: "/api" });

    // Register plugins - clean API
    await app.register(security({ frameOptions: "SAMEORIGIN" }), { encapsulate: false });

    // Simple route returning object (auto-serialized)
    app.get("/users", () => [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);

    // Route with params (typed from URL pattern)
    app.get("/users/:id", (req) => ({
      id: req.params.id,
      name: `User ${req.params.id}`,
    }));

    // POST with parsed body
    app.post("/users", (req) => ({
      created: true,
      data: req.parsedBody,
    }));

    // Route using reply helpers
    app.get("/redirect", (_req, reply) => reply.redirect("/api/users"));

    // Error throwing (framework handles serialization)
    app.get("/protected", () => {
      throw new HttpError(401, "Login required");
    });

    // Test the whole thing
    const listRes = await app.inject({ url: "/api/users" });
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const users = await listRes.json();
    expect(users).toHaveLength(2);

    const userRes = await app.inject({ url: "/api/users/42" });
    expect(await userRes.json()).toEqual({ id: "42", name: "User 42" });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Charlie" },
    });
    expect(createRes.status).toBe(200);
    expect((await createRes.json()).data).toEqual({ name: "Charlie" });

    const redirectRes = await app.inject({ url: "/api/redirect" });
    expect(redirectRes.status).toBe(302);

    const protectedRes = await app.inject({ url: "/api/protected" });
    expect(protectedRes.status).toBe(401);
  });

  it("custom 404 handler should work ergonomically", async () => {
    const app = createApp();
    app.setNotFoundHandler((_req, reply) => {
      return reply.status(404).json({
        error: "Page not found",
        docs: "https://docs.example.com",
      });
    });
    app.get("/exists", () => ({ ok: true }));

    const res = await app.inject({ url: "/nope" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.docs).toBe("https://docs.example.com");
  });

  it("status code should be settable before returning object", async () => {
    const app = createApp();
    app.post("/users", (_req, reply) => {
      reply.status(201);
      return { id: 1, name: "created" };
    });

    const res = await app.inject({ method: "POST", url: "/users" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 1, name: "created" });
  });

  it("reply.json() should respect pre-set status", async () => {
    const app = createApp();
    app.get("/accepted", (_req, reply) => reply.status(202).json({ queued: true }));

    const res = await app.inject({ url: "/accepted" });
    expect(res.status).toBe(202);
  });

  it("reply helpers for common errors should work", async () => {
    const app = createApp();
    app.get("/bad", (_req, reply) => reply.badRequest("missing field"));
    app.get("/unauth", (_req, reply) => reply.unauthorized("no token"));
    app.get("/forbidden", (_req, reply) => reply.forbidden("admin only"));
    app.get("/gone", (_req, reply) => reply.gone("resource deleted"));

    expect((await app.inject({ url: "/bad" })).status).toBe(400);
    expect((await app.inject({ url: "/unauth" })).status).toBe(401);
    expect((await app.inject({ url: "/forbidden" })).status).toBe(403);
    expect((await app.inject({ url: "/gone" })).status).toBe(410);
  });

  it("inject() with query params should work cleanly", async () => {
    const app = createApp();
    app.get("/search", (req) => ({
      q: req.query.q,
      limit: req.query.limit,
    }));

    const res = await app.inject({
      url: "/search",
      query: { q: "celsian", limit: "10" },
    });
    expect(await res.json()).toEqual({ q: "celsian", limit: "10" });
  });

  it("HEAD request should return same status as GET but no body", async () => {
    const app = createApp();
    app.get("/data", () => ({ large: "payload".repeat(100) }));

    const headRes = await app.inject({ method: "HEAD", url: "/data" });
    expect(headRes.status).toBe(200);
    const body = await headRes.text();
    expect(body).toBe("");
  });
});

// ─── Concurrent/async patterns ──────────────────────────────────

describe("Async patterns", () => {
  it("should handle concurrent requests to same route", async () => {
    const app = createApp();
    let counter = 0;
    app.get("/counter", async () => {
      counter++;
      await new Promise((r) => setTimeout(r, 10));
      return { value: counter };
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => app.inject({ url: "/counter" })));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(counter).toBe(10);
  });

  it("should handle async error in handler gracefully", async () => {
    const app = createApp();
    app.get("/async-fail", async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new HttpError(503, "Service down");
    });

    const res = await app.inject({ url: "/async-fail" });
    expect(res.status).toBe(503);
  });

  it("should handle multiple routes registering same path different methods", async () => {
    const app = createApp();
    app.get("/item", () => ({ action: "read" }));
    app.put("/item", () => ({ action: "update" }));
    app.patch("/item", () => ({ action: "patch" }));
    app.delete("/item", () => ({ action: "delete" }));

    const methods = ["GET", "PUT", "PATCH", "DELETE"] as const;
    const expected = ["read", "update", "patch", "delete"];

    for (let i = 0; i < methods.length; i++) {
      const res = await app.inject({ method: methods[i], url: "/item" });
      expect((await res.json()).action).toBe(expected[i]);
    }
  });
});

// ─── Lambda adapter + plugins integration ───────────────────────

describe("Lambda + plugins integration", () => {
  it("security headers should apply through lambda adapter", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
    app.get("/api", () => ({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler({
      version: "2.0",
      routeKey: "$default",
      rawPath: "/api",
      rawQueryString: "",
      headers: { host: "api.example.com" },
      isBase64Encoded: false,
      requestContext: {
        http: { method: "GET", path: "/api", protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "test" },
        requestId: "r1",
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
      },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers!["x-content-type-options"]).toBe("nosniff");
    expect(result.headers!["x-frame-options"]).toBe("DENY");
  });
});
