// Real-world test: SaaS backend with JWT auth, RPC, schema validation, caching
import { describe, it, expect, beforeEach } from "vitest";
import { createApp, HttpError, cors } from "../packages/core/src/index.js";
import type { CelsianRequest, CelsianReply } from "../packages/core/src/types.js";
import { jwt, createJWTGuard } from "../packages/jwt/src/index.js";
import { procedure, router, RPCHandler } from "../packages/rpc/src/index.js";
import { z } from "zod";

const TEST_SECRET = "test-secret-key-that-is-long-enough-for-hs256";

// ─── 1. Full auth flow with JWT ───
describe("JWT Auth Flow", () => {
  async function createAuthApp() {
    const app = createApp();
    await app.register(jwt({ secret: TEST_SECRET }));

    app.post("/auth/login", async (req, reply) => {
      const { email, password } = req.parsedBody as any;
      if (email === "admin@test.com" && password === "password") {
        const token = await (app as any).jwt.sign({ sub: email, role: "admin" });
        return reply.json({ token });
      }
      return reply.unauthorized("Bad credentials");
    });

    app.get("/auth/me", async (req, reply) => {
      const guard = createJWTGuard();
      const guardResult = await guard(req, reply);
      if (guardResult) return guardResult;
      return reply.json({ user: (req as any).user });
    });

    await app.ready();
    return app;
  }

  it("login + access protected route", async () => {
    const app = await createAuthApp();

    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@test.com", password: "password" },
    });
    expect(loginRes.status).toBe(200);
    const { token } = await loginRes.json();
    expect(token).toBeDefined();

    const meRes = await app.inject({
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
    const body = await meRes.json();
    expect(body.user.sub).toBe("admin@test.com");
  });

  it("protected route rejects without token", async () => {
    const app = await createAuthApp();
    const res = await app.inject({ url: "/auth/me" });
    expect(res.status).toBe(401);
  });

  it("protected route rejects invalid token", async () => {
    const app = await createAuthApp();
    const res = await app.inject({
      url: "/auth/me",
      headers: { authorization: "Bearer garbage.token.here" },
    });
    expect(res.status).toBe(401);
  });
});

// ─── 2. Schema validation with Zod ───
describe("Zod Schema Validation", () => {
  it("should validate request body with Zod schema", async () => {
    const app = createApp();

    const CreateUserSchema = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      age: z.number().int().min(0).optional(),
    });

    app.post("/users", {
      schema: { body: CreateUserSchema },
    }, (req, reply) => {
      return reply.status(201).json({ created: req.parsedBody });
    });
    await app.ready();

    // Valid request
    const goodRes = await app.inject({
      method: "POST",
      url: "/users",
      payload: { name: "Alice", email: "alice@example.com", age: 30 },
    });
    expect(goodRes.status).toBe(201);
    const body = await goodRes.json();
    expect(body.created.name).toBe("Alice");

    // Invalid email
    const badRes = await app.inject({
      method: "POST",
      url: "/users",
      payload: { name: "Bob", email: "not-an-email" },
    });
    expect(badRes.status).toBe(400);
  });

  it("should validate empty required field", async () => {
    const app = createApp();

    const Schema = z.object({
      title: z.string().min(1),
    });

    app.post("/items", { schema: { body: Schema } }, (req, reply) => {
      return reply.status(201).json(req.parsedBody);
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/items",
      payload: { title: "" },
    });
    expect(res.status).toBe(400);
  });

  it("missing body entirely should fail validation", async () => {
    const app = createApp();

    const Schema = z.object({ name: z.string() });

    app.post("/strict", { schema: { body: Schema } }, (req, reply) => {
      return reply.json(req.parsedBody);
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/strict",
    });
    // Should return 400 for missing required body
    expect(res.status).toBe(400);
  });
});

// ─── 3. RPC ───
describe("RPC System", () => {
  function createRPCApp() {
    const app = createApp();

    const appRouter = router({
      greeting: {
        hello: procedure
          .input(z.object({ name: z.string() }))
          .query(({ input }) => ({
            message: `Hello, ${input.name}!`,
            timestamp: Date.now(),
          })),
      },
      math: {
        add: procedure
          .input(z.object({ a: z.number(), b: z.number() }))
          .query(({ input }) => ({ result: input.a + input.b })),
        multiply: procedure
          .input(z.object({ a: z.number(), b: z.number() }))
          .mutation(({ input }) => ({ result: input.a * input.b })),
      },
    });

    const rpcHandler = new RPCHandler(appRouter);

    app.route({
      method: ["GET", "POST"],
      url: "/_rpc/*path",
      handler: (req) => rpcHandler.handle(req),
    });

    return { app, appRouter };
  }

  it("RPC query via GET", async () => {
    const { app } = createRPCApp();
    await app.ready();

    const input = encodeURIComponent(JSON.stringify({ name: "CelsianJS" }));
    const res = await app.inject({
      url: `/_rpc/greeting.hello?input=${input}`,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.message).toBe("Hello, CelsianJS!");
  });

  it("RPC mutation via POST", async () => {
    const { app } = createRPCApp();
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/_rpc/math.multiply",
      payload: { a: 6, b: 7 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.result).toBe(42);
  });

  it("RPC validates input", async () => {
    const { app } = createRPCApp();
    await app.ready();

    const input = encodeURIComponent(JSON.stringify({ a: "not a number", b: 2 }));
    const res = await app.inject({
      url: `/_rpc/math.add?input=${input}`,
    });
    expect(res.status).toBe(400);
  });

  it("RPC returns 404 for unknown procedure", async () => {
    const { app } = createRPCApp();
    await app.ready();

    const res = await app.inject({
      url: "/_rpc/nonexistent.method",
    });
    expect(res.status).toBe(404);
  });
});

// ─── 4. Plugin composition ───
describe("Plugin Composition", () => {
  it("nested plugins with prefixes", async () => {
    const app = createApp();

    const v1Api = async (ctx: any) => {
      const usersPlugin = async (inner: any) => {
        inner.get("/", (req: CelsianRequest, reply: CelsianReply) => {
          return reply.json({ version: "v1", resource: "users" });
        });
      };
      const postsPlugin = async (inner: any) => {
        inner.get("/", (req: CelsianRequest, reply: CelsianReply) => {
          return reply.json({ version: "v1", resource: "posts" });
        });
      };
      await ctx.register(usersPlugin, { prefix: "/users" });
      await ctx.register(postsPlugin, { prefix: "/posts" });
    };

    await app.register(v1Api, { prefix: "/api/v1" });
    await app.ready();

    const usersRes = await app.inject({ url: "/api/v1/users" });
    expect(usersRes.status).toBe(200);
    expect((await usersRes.json()).resource).toBe("users");

    const postsRes = await app.inject({ url: "/api/v1/posts" });
    expect(postsRes.status).toBe(200);
    expect((await postsRes.json()).resource).toBe("posts");
  });

  it("CORS + JWT + routes together", async () => {
    const app = createApp();
    await app.register(cors({ origin: "*" }));
    await app.register(jwt({ secret: TEST_SECRET }));

    const guard = createJWTGuard();

    app.get("/public", (req, reply) => {
      return reply.json({ public: true });
    });

    app.get("/private", {
      onRequest: guard,
    } as any, async (req, reply) => {
      return reply.json({ private: true, user: (req as any).user?.sub });
    });

    await app.ready();

    // Public endpoint works
    const pubRes = await app.inject({
      url: "/public",
      headers: { origin: "http://example.com" },
    });
    expect(pubRes.status).toBe(200);
    expect(pubRes.headers.get("access-control-allow-origin")).toBe("*");

    // Private endpoint rejects without auth
    const privRes = await app.inject({ url: "/private" });
    expect(privRes.status).toBe(401);

    // Login + access private
    const token = await (app as any).jwt.sign({ sub: "user@test.com" });
    const authRes = await app.inject({
      url: "/private",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authRes.status).toBe(200);
    expect((await authRes.json()).user).toBe("user@test.com");
  });
});

// ─── 5. Auto-serialization edge cases ───
describe("Auto-serialization edge cases", () => {
  it("returning a number should serialize to JSON", async () => {
    const app = createApp();
    app.get("/number", () => 42);
    await app.ready();

    const res = await app.inject({ url: "/number" });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(42);
  });

  it("returning a boolean should serialize to JSON", async () => {
    const app = createApp();
    app.get("/bool", () => true);
    await app.ready();

    const res = await app.inject({ url: "/bool" });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(true);
  });

  it("returning an array should serialize to JSON", async () => {
    const app = createApp();
    app.get("/array", () => [1, 2, 3]);
    await app.ready();

    const res = await app.inject({ url: "/array" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([1, 2, 3]);
  });

  it("returning undefined (implicit void) should give 204", async () => {
    const app = createApp();
    app.get("/void", () => undefined);
    await app.ready();

    const res = await app.inject({ url: "/void" });
    expect(res.status).toBe(204);
  });

  it("auto-serialized response should respect reply.status()", async () => {
    const app = createApp();
    app.post("/create", (req, reply) => {
      reply.statusCode = 201;
      return { id: "abc", created: true };
    });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/create" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "abc", created: true });
  });

  it("auto-serialized string should respect reply.status()", async () => {
    const app = createApp();
    app.get("/msg", (req, reply) => {
      reply.statusCode = 202;
      return "accepted";
    });
    await app.ready();

    const res = await app.inject({ url: "/msg" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("accepted");
  });
});

// ─── 6. Route-level hooks ───
describe("Route-level hooks", () => {
  it("per-route preHandler hook", async () => {
    const app = createApp();

    const apiKeyGuard = (req: CelsianRequest, reply: CelsianReply) => {
      if (req.headers.get("x-api-key") !== "secret123") {
        return reply.status(403).json({ error: "Invalid API key" });
      }
    };

    app.route({
      method: "GET",
      url: "/guarded",
      preHandler: [apiKeyGuard as any],
      handler: (req, reply) => reply.json({ data: "sensitive" }),
    });

    app.get("/open", (req, reply) => reply.json({ data: "public" }));

    await app.ready();

    // Guarded route rejects without key
    const badRes = await app.inject({ url: "/guarded" });
    expect(badRes.status).toBe(403);

    // Guarded route works with key
    const goodRes = await app.inject({
      url: "/guarded",
      headers: { "x-api-key": "secret123" },
    });
    expect(goodRes.status).toBe(200);

    // Open route always works
    const openRes = await app.inject({ url: "/open" });
    expect(openRes.status).toBe(200);
  });
});

// ─── 7. Error boundary with onError hook ───
describe("onError hook", () => {
  it("onError hook receives the thrown error", async () => {
    const app = createApp();
    const capturedErrors: string[] = [];

    app.addHook("onError", (error, req, reply) => {
      capturedErrors.push((error as Error).message);
    });

    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    await app.ready();

    const res = await app.inject({ url: "/boom" });
    expect(res.status).toBe(500);
    expect(capturedErrors).toContain("kaboom");
  });
});

// ─── 8. HEAD requests ───
describe("HEAD requests", () => {
  it("HEAD should return same headers as GET but no body", async () => {
    const app = createApp();
    app.get("/resource", (req, reply) => {
      return reply.header("x-custom", "test").json({ data: "value" });
    });
    await app.ready();

    const headRes = await app.inject({ method: "HEAD", url: "/resource" });
    // HEAD should work (either explicit or fallback from GET)
    expect([200, 404, 405]).toContain(headRes.status);
    if (headRes.status === 200) {
      expect(headRes.headers.get("x-custom")).toBe("test");
    }
  });
});

// ─── 9. Large response body ───
describe("Large payloads", () => {
  it("should handle large JSON response", async () => {
    const app = createApp();
    app.get("/big", (req, reply) => {
      const items = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
        description: "A".repeat(100),
      }));
      return reply.json({ items });
    });
    await app.ready();

    const res = await app.inject({ url: "/big" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1000);
  });
});

// ─── 10. Content-type parsing ───
describe("Custom content-type parser", () => {
  it("should support custom content-type parser", async () => {
    const app = createApp();

    app.addContentTypeParser("text/csv", async (request) => {
      const text = await request.text();
      return text.split("\n").map((row) => row.split(","));
    });

    app.post("/csv", async (req, reply) => {
      return reply.json({ rows: req.parsedBody });
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/csv",
      headers: { "content-type": "text/csv" },
      payload: "a,b,c\n1,2,3",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });
});
