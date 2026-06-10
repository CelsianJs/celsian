// Stress test: use CelsianJS like a real developer and find DX issues
import { beforeEach, describe, expect, it } from "vitest";
import { cors, createApp, createSSEHub, createSSEStream, HttpError } from "../../../packages/core/src/index.js";
import type { CelsianReply, CelsianRequest } from "../../../packages/core/src/types.js";

// ─── 1. Plain object return from handler (DX trap?) ───
describe("Handler return semantics", () => {
  it("returning a plain object from handler should serialize to JSON", async () => {
    const app = createApp();
    app.get("/plain", (req, reply) => {
      return { hello: "world" };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/plain" });
    // A real dev would expect 200 + JSON body
    // If this fails, it's a critical DX issue
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hello: "world" });
  });

  it("returning a string from handler should send as text", async () => {
    const app = createApp();
    app.get("/text", (req, reply) => {
      return "hello world";
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/text" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("hello world");
  });

  it("returning null should give 204", async () => {
    const app = createApp();
    app.get("/empty", (req, reply) => {
      return null;
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/empty" });
    expect(res.status).toBe(204);
  });

  it("void return (no return) should give 204", async () => {
    const app = createApp();
    app.get("/void", (req, reply) => {
      // intentionally no return — dev might expect 200
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/void" });
    expect(res.status).toBe(204);
  });

  it("reply.json() should work correctly", async () => {
    const app = createApp();
    app.get("/reply-json", (req, reply) => {
      return reply.json({ using: "reply" });
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/reply-json" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ using: "reply" });
  });

  it("reply.status(201).json() should set correct status", async () => {
    const app = createApp();
    app.post("/create", (req, reply) => {
      return reply.status(201).json({ created: true });
    });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/create" });
    expect(res.status).toBe(201);
  });
});

// ─── 2. Route params ───
describe("Route parameters", () => {
  it("should extract single param", async () => {
    const app = createApp();
    app.get("/users/:id", (req, reply) => {
      return reply.json({ id: req.params.id });
    });
    await app.ready();

    const res = await app.inject({ url: "/users/42" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42" });
  });

  it("should extract multiple params", async () => {
    const app = createApp();
    app.get("/users/:userId/posts/:postId", (req, reply) => {
      return reply.json({ userId: req.params.userId, postId: req.params.postId });
    });
    await app.ready();

    const res = await app.inject({ url: "/users/1/posts/99" });
    expect(await res.json()).toEqual({ userId: "1", postId: "99" });
  });

  it("should handle wildcard routes", async () => {
    const app = createApp();
    app.get("/files/*", (req, reply) => {
      return reply.json({ path: req.params["*"] });
    });
    await app.ready();

    const res = await app.inject({ url: "/files/docs/readme.md" });
    expect(await res.json()).toEqual({ path: "docs/readme.md" });
  });
});

// ─── 3. Query string parsing ───
describe("Query strings", () => {
  it("should parse simple query params", async () => {
    const app = createApp();
    app.get("/search", (req, reply) => {
      return reply.json({ q: req.query.q, page: req.query.page });
    });
    await app.ready();

    const res = await app.inject({ url: "/search?q=celsian&page=2" });
    const body = await res.json();
    expect(body.q).toBe("celsian");
    expect(body.page).toBe("2");
  });

  it("should handle repeated query params as arrays", async () => {
    const app = createApp();
    app.get("/filter", (req, reply) => {
      return reply.json({ tags: req.query.tag });
    });
    await app.ready();

    const res = await app.inject({ url: "/filter?tag=a&tag=b&tag=c" });
    const body = await res.json();
    // Should be an array for repeated params
    expect(body.tags).toEqual(["a", "b", "c"]);
  });
});

// ─── 4. Body parsing ───
describe("Body parsing", () => {
  it("should parse JSON body", async () => {
    const app = createApp();
    app.post("/echo", async (req, reply) => {
      return reply.json({ received: req.parsedBody });
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/echo",
      payload: { name: "test", count: 42 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toEqual({ name: "test", count: 42 });
  });

  it("should handle empty POST body gracefully", async () => {
    const app = createApp();
    app.post("/empty-body", async (req, reply) => {
      return reply.json({ body: req.parsedBody ?? null });
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/empty-body",
    });
    expect(res.status).toBe(200);
  });
});

// ─── 5. Hooks lifecycle ───
describe("Hooks", () => {
  it("onRequest hook should run before handler", async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook("onRequest", (req, reply) => {
      order.push("onRequest");
    });

    app.get("/hooked", (req, reply) => {
      order.push("handler");
      return reply.json({ order });
    });
    await app.ready();

    const res = await app.inject({ url: "/hooked" });
    const body = await res.json();
    expect(body.order).toEqual(["onRequest", "handler"]);
  });

  it("preHandler hook can short-circuit with a Response", async () => {
    const app = createApp();

    app.addHook("preHandler", (req, reply) => {
      return reply.status(403).json({ error: "blocked" });
    });

    app.get("/blocked", (req, reply) => {
      return reply.json({ should: "not reach" });
    });
    await app.ready();

    const res = await app.inject({ url: "/blocked" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked" });
  });

  it("onResponse hook fires after response", async () => {
    const app = createApp();
    let called = false;

    app.addHook("onResponse", (req, reply) => {
      called = true;
    });

    app.get("/response-hook", (req, reply) => {
      return reply.json({ ok: true });
    });
    await app.ready();

    await app.inject({ url: "/response-hook" });
    // Give fire-and-forget a tick to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(true);
  });
});

// ─── 6. Error handling ───
describe("Error handling", () => {
  it("thrown HttpError should produce correct status", async () => {
    const app = createApp();
    app.get("/fail", () => {
      throw new HttpError(422, "Validation failed");
    });
    await app.ready();

    const res = await app.inject({ url: "/fail" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
  });

  it("thrown plain Error should produce 500", async () => {
    const app = createApp();
    app.get("/crash", () => {
      throw new Error("something broke");
    });
    await app.ready();

    const res = await app.inject({ url: "/crash" });
    expect(res.status).toBe(500);
  });

  it("custom error handler should intercept errors", async () => {
    const app = createApp();
    app.setErrorHandler((error, req, reply) => {
      return reply.status(418).json({ custom: true, message: error.message });
    });
    app.get("/custom-error", () => {
      throw new Error("teapot");
    });
    await app.ready();

    const res = await app.inject({ url: "/custom-error" });
    expect(res.status).toBe(418);
    expect((await res.json()).custom).toBe(true);
  });
});

// ─── 7. Plugins ───
describe("Plugins", () => {
  it("should encapsulate plugin routes with prefix", async () => {
    const app = createApp();

    const usersPlugin = async (ctx: any) => {
      ctx.get("/", (req: CelsianRequest, reply: CelsianReply) => {
        return reply.json({ users: [] });
      });
      ctx.get("/:id", (req: CelsianRequest, reply: CelsianReply) => {
        return reply.json({ user: req.params.id });
      });
    };

    await app.register(usersPlugin, { prefix: "/api/users" });
    await app.ready();

    const res = await app.inject({ url: "/api/users" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: [] });

    const res2 = await app.inject({ url: "/api/users/42" });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ user: "42" });
  });

  it("decorate should add properties to the app", async () => {
    const app = createApp();
    app.decorate("db", { query: () => "result" });
    await app.ready();

    expect((app as any).db.query()).toBe("result");
  });

  it("decorateRequest should add properties to every request", async () => {
    const app = createApp();
    app.decorateRequest("startTime", 0);
    app.addHook("onRequest", (req) => {
      (req as any).startTime = Date.now();
    });

    app.get("/timed", (req, reply) => {
      return reply.json({ hasStartTime: typeof (req as any).startTime === "number" });
    });
    await app.ready();

    const res = await app.inject({ url: "/timed" });
    expect((await res.json()).hasStartTime).toBe(true);
  });
});

// ─── 8. CORS ───
describe("CORS plugin", () => {
  it("should add CORS headers", async () => {
    const app = createApp();
    await app.register(cors({ origin: "*" }));

    app.get("/cors-test", (req, reply) => {
      return reply.json({ ok: true });
    });
    await app.ready();

    const res = await app.inject({
      url: "/cors-test",
      headers: { origin: "http://example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("should handle preflight OPTIONS", async () => {
    const app = createApp();
    await app.register(cors({ origin: "*" }));
    await app.ready();

    const res = await app.inject({
      method: "OPTIONS",
      url: "/anything",
      headers: {
        origin: "http://example.com",
        "access-control-request-method": "POST",
      },
    });
    // Preflight should return 204 or 200
    expect(res.status).toBeLessThanOrEqual(204);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });
});

// ─── 9. Reply helpers ───
describe("Reply helpers", () => {
  it("notFound() should return 404", async () => {
    const app = createApp();
    app.get("/check/:id", (req, reply) => {
      if (req.params.id === "missing") {
        return reply.notFound("Item not found");
      }
      return reply.json({ id: req.params.id });
    });
    await app.ready();

    const res = await app.inject({ url: "/check/missing" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("badRequest() should return 400", async () => {
    const app = createApp();
    app.post("/validate", (req, reply) => {
      return reply.badRequest("Invalid input");
    });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/validate" });
    expect(res.status).toBe(400);
  });

  it("redirect() should set location header", async () => {
    const app = createApp();
    app.get("/old", (req, reply) => {
      return reply.redirect("/new");
    });
    await app.ready();

    const res = await app.inject({ url: "/old" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/new");
  });

  it("html() should set content-type", async () => {
    const app = createApp();
    app.get("/page", (req, reply) => {
      return reply.html("<h1>Hello</h1>");
    });
    await app.ready();

    const res = await app.inject({ url: "/page" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<h1>Hello</h1>");
  });

  it("cookies should be settable and clearable", async () => {
    const app = createApp();
    app.get("/set-cookie", (req, reply) => {
      return reply.cookie("session", "abc123", { httpOnly: true, path: "/" }).json({ set: true });
    });
    app.get("/clear-cookie", (req, reply) => {
      return reply.clearCookie("session").json({ cleared: true });
    });
    await app.ready();

    const res = await app.inject({ url: "/set-cookie" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("session=abc123");
    expect(setCookie).toContain("HttpOnly");
  });
});

// ─── 10. SSE ───
describe("SSE", () => {
  it("createSSEHub should broadcast to subscribers", async () => {
    const hub = createSSEHub();

    // Create a mock request with an AbortController
    const controller = new AbortController();
    const mockRequest = new Request("http://localhost/events", {
      signal: controller.signal,
    });

    const channel = hub.subscribe(mockRequest);
    expect(hub.size).toBe(1);

    // Send an event
    channel.send({ event: "test", data: { hello: "world" } });

    // Verify channel is open
    expect(channel.open).toBe(true);

    // Close everything
    controller.abort();
    hub.closeAll();
    expect(hub.size).toBe(0);
  });

  it("createSSEStream should produce a valid SSE response", () => {
    const controller = new AbortController();
    const req = new Request("http://localhost/stream", {
      signal: controller.signal,
    });
    const channel = createSSEStream(req);

    expect(channel.response.headers.get("content-type")).toBe("text/event-stream");
    expect(channel.response.headers.get("cache-control")).toBe("no-cache");
    expect(channel.open).toBe(true);

    channel.close();
    controller.abort();
  });
});

// ─── 11. Not Found Handler ───
describe("404 handling", () => {
  it("should return 404 for unknown routes", async () => {
    const app = createApp();
    app.get("/exists", (req, reply) => reply.json({ ok: true }));
    await app.ready();

    const res = await app.inject({ url: "/does-not-exist" });
    expect(res.status).toBe(404);
  });

  it("custom not-found handler should work", async () => {
    const app = createApp();
    app.setNotFoundHandler((req, reply) => {
      return reply.status(404).json({ custom404: true, path: req.url });
    });
    await app.ready();

    const res = await app.inject({ url: "/nope" });
    expect(res.status).toBe(404);
    expect((await res.json()).custom404).toBe(true);
  });
});

// ─── 12. Method not allowed ───
describe("405 Method Not Allowed", () => {
  it("should return 405 when route exists but method doesn't", async () => {
    const app = createApp();
    app.get("/only-get", (req, reply) => reply.json({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/only-get" });
    // Framework should distinguish 404 vs 405
    expect(res.status).toBe(405);
  });
});

// ─── 13. Edge cases ───
describe("Edge cases", () => {
  it("trailing slash normalization", async () => {
    const app = createApp();
    app.get("/items", (req, reply) => reply.json({ ok: true }));
    await app.ready();

    const res = await app.inject({ url: "/items/" });
    // Should either match or 404 — shouldn't crash
    expect([200, 301, 404]).toContain(res.status);
  });

  it("double slash in URL shouldn't crash", async () => {
    const app = createApp();
    app.get("/safe", (req, reply) => reply.json({ ok: true }));
    await app.ready();

    const res = await app.inject({ url: "//safe" });
    expect(typeof res.status).toBe("number");
  });

  it("unicode in URL params", async () => {
    const app = createApp();
    app.get("/greet/:name", (req, reply) => {
      return reply.json({ greeting: `Hello ${req.params.name}` });
    });
    await app.ready();

    const res = await app.inject({ url: `/greet/${encodeURIComponent("日本語")}` });
    expect(res.status).toBe(200);
  });

  it("very long URL shouldn't crash", async () => {
    const app = createApp();
    app.get("/long", (req, reply) => reply.json({ ok: true }));
    await app.ready();

    const longQuery = "x=" + "a".repeat(10_000);
    const res = await app.inject({ url: `/long?${longQuery}` });
    // Should handle or reject gracefully
    expect(typeof res.status).toBe("number");
  });

  it("concurrent requests should be isolated", async () => {
    const app = createApp();
    app.get("/slow/:id", async (req, reply) => {
      await new Promise((r) => setTimeout(r, 10));
      return reply.json({ id: req.params.id });
    });
    await app.ready();

    const results = await Promise.all([
      app.inject({ url: "/slow/1" }).then((r) => r.json()),
      app.inject({ url: "/slow/2" }).then((r) => r.json()),
      app.inject({ url: "/slow/3" }).then((r) => r.json()),
    ]);

    expect(results.map((r: any) => r.id)).toEqual(["1", "2", "3"]);
  });
});

// ─── 14. Async handlers ───
describe("Async handlers", () => {
  it("async handler should work with reply.json()", async () => {
    const app = createApp();
    app.get("/async", async (req, reply) => {
      const data = await Promise.resolve({ computed: true });
      return reply.json(data);
    });
    await app.ready();

    const res = await app.inject({ url: "/async" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ computed: true });
  });

  it("async handler rejection should become 500", async () => {
    const app = createApp();
    app.get("/async-fail", async () => {
      throw new Error("async boom");
    });
    await app.ready();

    const res = await app.inject({ url: "/async-fail" });
    expect(res.status).toBe(500);
  });
});

// ─── 15. Multiple HTTP methods ───
describe("Multi-method routes", () => {
  it("route() with multiple methods", async () => {
    const app = createApp();
    app.route({
      method: ["GET", "POST"],
      url: "/multi",
      handler: (req, reply) => reply.json({ method: req.method }),
    });
    await app.ready();

    const getRes = await app.inject({ method: "GET", url: "/multi" });
    expect((await getRes.json()).method).toBe("GET");

    const postRes = await app.inject({ method: "POST", url: "/multi" });
    expect((await postRes.json()).method).toBe("POST");
  });
});

// ─── 16. Content-type header on responses ───
describe("Content-type headers", () => {
  it("reply.json() should set application/json", async () => {
    const app = createApp();
    app.get("/json", (req, reply) => reply.json({ ok: true }));
    await app.ready();

    const res = await app.inject({ url: "/json" });
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("reply.html() should set text/html", async () => {
    const app = createApp();
    app.get("/html", (req, reply) => reply.html("<p>hi</p>"));
    await app.ready();

    const res = await app.inject({ url: "/html" });
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("reply.send(string) should set text/plain", async () => {
    const app = createApp();
    app.get("/text", (req, reply) => reply.send("plain text"));
    await app.ready();

    const res = await app.inject({ url: "/text" });
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});

// ─── 17. App prefix ───
describe("App-level prefix", () => {
  it("should prefix all routes", async () => {
    const app = createApp({ prefix: "/api/v1" });
    app.get("/health", (req, reply) => reply.json({ ok: true }));
    await app.ready();

    const res = await app.inject({ url: "/api/v1/health" });
    expect(res.status).toBe(200);

    // Unprefixed should 404
    const res2 = await app.inject({ url: "/health" });
    expect(res2.status).toBe(404);
  });
});
