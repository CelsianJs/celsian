import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("CelsianApp", () => {
  it("should handle GET requests", async () => {
    const app = createApp();
    app.get("/hello", (_req, reply) => reply.json({ message: "hello" }));

    const response = await app.handle(new Request("http://localhost/hello"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ message: "hello" });
  });

  it("should handle POST requests", async () => {
    const app = createApp();
    app.post("/data", (_req, reply) => reply.json({ received: true }));

    const response = await app.handle(new Request("http://localhost/data", { method: "POST" }));
    expect(response.status).toBe(200);
  });

  it("should return 404 for unmatched routes", async () => {
    const app = createApp();
    app.get("/exists", (_req, reply) => reply.json({ ok: true }));

    const response = await app.handle(new Request("http://localhost/nope"));
    expect(response.status).toBe(404);
  });

  it("should parse URL params", async () => {
    const app = createApp();
    app.get("/users/:id", (req, reply) => {
      return reply.json({ id: req.params.id });
    });

    const response = await app.handle(new Request("http://localhost/users/42"));
    const body = await response.json();
    expect(body).toEqual({ id: "42" });
  });

  it("should parse query parameters", async () => {
    const app = createApp();
    app.get("/search", (req, reply) => {
      return reply.json({ q: req.query.q, page: req.query.page });
    });

    const response = await app.handle(new Request("http://localhost/search?q=hello&page=2"));
    const body = await response.json();
    expect(body).toEqual({ q: "hello", page: "2" });
  });

  it("should parse JSON body", async () => {
    const app = createApp();
    app.post("/data", (req, reply) => {
      return reply.json({ body: req.parsedBody });
    });

    const response = await app.handle(
      new Request("http://localhost/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      }),
    );
    const body = await response.json();
    expect(body).toEqual({ body: { name: "test" } });
  });

  it("should return 204 for void handlers", async () => {
    const app = createApp();
    app.post("/void", () => {
      // No return
    });

    const response = await app.handle(new Request("http://localhost/void", { method: "POST" }));
    expect(response.status).toBe(204);
  });

  it("should support route prefixes", async () => {
    const app = createApp({ prefix: "/api" });
    app.get("/health", (_req, reply) => reply.json({ ok: true }));

    const response = await app.handle(new Request("http://localhost/api/health"));
    expect(response.status).toBe(200);
  });

  it("should support plugins with prefix", async () => {
    const app = createApp();

    await app.register(
      async (ctx) => {
        ctx.get("/list", (_req, reply) => reply.json({ items: [] }));
      },
      { prefix: "/api/v1" },
    );

    const response = await app.handle(new Request("http://localhost/api/v1/list"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ items: [] });
  });

  it("should run onRequest hooks", async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook("onRequest", () => {
      order.push("onRequest");
    });

    app.get("/test", (_req, reply) => {
      order.push("handler");
      return reply.json({ ok: true });
    });

    await app.handle(new Request("http://localhost/test"));
    expect(order).toEqual(["onRequest", "handler"]);
  });

  it("should allow hooks to short-circuit with early response", async () => {
    const app = createApp();

    app.addHook("onRequest", (_req, reply) => {
      return reply.status(401).json({ error: "Unauthorized" });
    });

    app.get("/protected", (_req, reply) => reply.json({ secret: true }));

    const response = await app.handle(new Request("http://localhost/protected"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("should handle errors with default handler", async () => {
    const app = createApp();

    app.get("/error", () => {
      throw new Error("Something went wrong");
    });

    const response = await app.handle(new Request("http://localhost/error"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Something went wrong");
  });

  it("should run onError hooks", async () => {
    const app = createApp();
    let caughtError: Error | null = null;

    app.addHook("onError", (error, _req, reply) => {
      caughtError = error;
      return reply.status(503).json({ error: "Custom error response" });
    });

    app.get("/error", () => {
      throw new Error("Test error");
    });

    const response = await app.handle(new Request("http://localhost/error"));
    expect(response.status).toBe(503);
    expect(caughtError?.message).toBe("Test error");
  });

  it("should support request decorations", async () => {
    const app = createApp();

    app.decorateRequest("startTime", () => Date.now());

    app.get("/decorated", (req, reply) => {
      return reply.json({ hasStartTime: typeof req.startTime === "number" });
    });

    const response = await app.handle(new Request("http://localhost/decorated"));
    const body = await response.json();
    expect(body.hasStartTime).toBe(true);
  });

  it("should expose fetch handler", async () => {
    const app = createApp();
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const fetch = app.fetch;
    const response = await fetch(new Request("http://localhost/test"));
    expect(response.status).toBe(200);
  });

  it("should list all routes", () => {
    const app = createApp();
    app.get("/a", () => {});
    app.post("/b", () => {});
    app.put("/c", () => {});

    const routes = app.getRoutes();
    expect(routes).toHaveLength(3);
    expect(routes.map((r) => r.method)).toEqual(["GET", "POST", "PUT"]);
  });

  it("should support route() with multiple methods", async () => {
    const app = createApp();
    app.route({
      method: ["GET", "POST"],
      url: "/both",
      handler(_req, reply) {
        return reply.json({ ok: true });
      },
    });

    const get = await app.handle(new Request("http://localhost/both"));
    expect(get.status).toBe(200);

    const post = await app.handle(new Request("http://localhost/both", { method: "POST" }));
    expect(post.status).toBe(200);
  });

  // ─── BUG-7: 405 Method Not Allowed ───

  it("should return 405 for wrong HTTP method on existing path", async () => {
    const app = createApp();
    app.get("/users", (_req, reply) => reply.json([]));

    const response = await app.handle(new Request("http://localhost/users", { method: "DELETE" }));
    expect(response.status).toBe(405);
    const body = await response.json();
    expect(body.code).toBe("METHOD_NOT_ALLOWED");
  });

  // ─── BUG-8: HEAD fallback to GET ───

  it("should handle HEAD requests by falling back to GET handler", async () => {
    const app = createApp();
    app.get("/data", (_req, reply) => reply.json({ hello: "world" }));

    const response = await app.handle(new Request("http://localhost/data", { method: "HEAD" }));
    expect(response.status).toBe(200);
  });

  // ─── BUG-11: URL-decoded path params ───

  it("should URL-decode path parameters", async () => {
    const app = createApp();
    app.get("/files/:name", (req, reply) => reply.json({ name: req.params.name }));

    const response = await app.handle(new Request("http://localhost/files/hello%20world"));
    const body = await response.json();
    expect(body.name).toBe("hello world");
  });

  // ─── BUG-13: Duplicate query params ───

  it("should preserve duplicate query parameters as arrays", async () => {
    const app = createApp();
    app.get("/search", (req, reply) => reply.json({ tags: req.query.tag }));

    const response = await app.handle(new Request("http://localhost/search?tag=a&tag=b&tag=c"));
    const body = await response.json();
    expect(body.tags).toEqual(["a", "b", "c"]);
  });

  // ─── BUG-4: Plugin decorations accessible as properties ───

  it("should sync non-encapsulated plugin decorations to app instance", async () => {
    const app = createApp();
    await app.register(
      (ctx) => {
        ctx.decorate("myService", { active: true });
      },
      { encapsulate: false },
    );
    await app.ready();

    expect((app as any).myService).toEqual({ active: true });
    expect(app.getDecoration("myService")).toEqual({ active: true });
  });

  it("should propagate encapsulated plugin decorations to app instance", async () => {
    const app = createApp();
    await app.register(
      (ctx) => {
        ctx.decorate("secret", 42);
      },
      // encapsulate defaults to true
    );
    await app.ready();

    // Decorations from encapsulated plugins are accessible on the app instance
    // so plugins like JWT work without requiring { encapsulate: false }
    expect((app as any).secret).toBe(42);
    expect(app.getDecoration("secret")).toBe(42);
  });

  // ─── BUG-5/6: onSend hook headers applied to Response ───

  it("should apply onSend hook headers to the response", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, reply) => {
      reply.header("x-custom", "from-hook");
    });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.handle(new Request("http://localhost/test"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-custom")).toBe("from-hook");
  });

  it("should handle reply.send(null) on 204 without throwing", async () => {
    const app = createApp();
    app.delete("/items/:id", (_req, reply) => reply.status(204).send(null));

    const response = await app.handle(new Request("http://localhost/items/1", { method: "DELETE" }));
    expect(response.status).toBe(204);
    const body = await response.text();
    expect(body).toBe("");
  });

  it("should return 404 (not 405) for non-existent paths with CORS enabled", async () => {
    const { cors } = await import("../src/plugins/cors.js");
    const app = createApp({ security: false });
    app.register(cors({ origin: "*" }), { encapsulate: false });
    app.get("/exists", (_req, reply) => reply.json({ ok: true }));

    const response = await app.handle(new Request("http://localhost/nope"));
    expect(response.status).toBe(404);
  });

  // ─── Schema Overload (3-arg) Tests ───

  it("should accept (path, schemaOptions, handler) overload and validate body", async () => {
    const app = createApp();

    // Use a Zod-like mock schema for validation
    const bodySchema = {
      safeParse(input: unknown) {
        const data = input as Record<string, unknown>;
        if (typeof data?.name === "string") {
          return { success: true, data };
        }
        return {
          success: false,
          error: { issues: [{ message: "name must be a string", path: ["name"] }] },
        };
      },
      parse(input: unknown) {
        return input;
      },
    };

    app.post(
      "/users",
      {
        schema: { body: bodySchema },
      },
      (req, reply) => {
        return reply.status(201).json({ created: req.parsedBody });
      },
    );

    // Valid body
    const valid = await app.handle(
      new Request("http://localhost/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      }),
    );
    expect(valid.status).toBe(201);
    const body = await valid.json();
    expect(body).toEqual({ created: { name: "Alice" } });

    // Invalid body — should return 400 from schema validation
    const invalid = await app.handle(
      new Request("http://localhost/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 123 }),
      }),
    );
    expect(invalid.status).toBe(400);
  });

  it("should support schema overload with route params", async () => {
    const app = createApp();

    const bodySchema = {
      safeParse(input: unknown) {
        return { success: true, data: input };
      },
      parse(input: unknown) {
        return input;
      },
    };

    app.put(
      "/users/:id",
      {
        schema: { body: bodySchema },
      },
      (req, reply) => {
        return reply.json({ id: req.params.id, body: req.parsedBody });
      },
    );

    const response = await app.handle(
      new Request("http://localhost/users/42", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ id: "42", body: { name: "Updated" } });
  });

  it("should support schema overload with onRequest hook", async () => {
    const app = createApp();
    let hookRan = false;

    const bodySchema = {
      safeParse(input: unknown) {
        return { success: true, data: input };
      },
      parse(input: unknown) {
        return input;
      },
    };

    app.post(
      "/hooked",
      {
        schema: { body: bodySchema },
        onRequest: () => {
          hookRan = true;
        },
      },
      (req, reply) => {
        return reply.json({ received: req.parsedBody });
      },
    );

    const response = await app.handle(
      new Request("http://localhost/hooked", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test: true }),
      }),
    );
    expect(response.status).toBe(200);
    expect(hookRan).toBe(true);
  });

  it("should still work with old 2-arg signature alongside new 3-arg", async () => {
    const app = createApp();

    // Old API
    app.post("/old", (req, reply) => {
      return reply.json({ old: true, body: req.parsedBody });
    });

    // New API
    const bodySchema = {
      safeParse(input: unknown) {
        return { success: true, data: input };
      },
      parse(input: unknown) {
        return input;
      },
    };

    app.post("/new", { schema: { body: bodySchema } }, (req, reply) => {
      return reply.json({ new: true, body: req.parsedBody });
    });

    const oldRes = await app.handle(
      new Request("http://localhost/old", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: "old" }),
      }),
    );
    expect(oldRes.status).toBe(200);
    expect(await oldRes.json()).toEqual({ old: true, body: { data: "old" } });

    const newRes = await app.handle(
      new Request("http://localhost/new", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: "new" }),
      }),
    );
    expect(newRes.status).toBe(200);
    expect(await newRes.json()).toEqual({ new: true, body: { data: "new" } });
  });
});
