import { describe, expect, it } from "vitest";
import { procedure } from "../src/procedure.js";
import { RPCHandler, router } from "../src/router.js";
import { encode } from "../src/wire.js";

describe("router()", () => {
  it("should return the routes as-is", () => {
    const routes = router({
      hello: procedure.query(async () => "world"),
    });
    expect(routes.hello.type).toBe("query");
  });
});

describe("RPCHandler", () => {
  function createHandler() {
    const routes = router({
      greeting: {
        hello: procedure.query(async ({ input }) => {
          return { message: `Hello, ${(input as any).name}!` };
        }),
      },
      math: {
        add: procedure.mutation(async ({ input }) => {
          return { result: (input as any).a + (input as any).b };
        }),
      },
    });
    return new RPCHandler(routes);
  }

  it("should handle query via GET", async () => {
    const handler = createHandler();
    const input = JSON.stringify(encode({ name: "World" }));
    const url = `http://localhost/_rpc/greeting.hello?input=${encodeURIComponent(input)}`;

    const response = await handler.handle(new Request(url));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toEqual({ message: "Hello, World!" });
  });

  it("should handle mutation via POST", async () => {
    const handler = createHandler();
    const response = await handler.handle(
      new Request("http://localhost/_rpc/math.add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(encode({ a: 2, b: 3 })),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toEqual({ result: 5 });
  });

  it("should reject mutation via GET", async () => {
    const handler = createHandler();
    const response = await handler.handle(new Request("http://localhost/_rpc/math.add"));
    expect(response.status).toBe(405);
  });

  it("should return 404 for unknown procedures", async () => {
    const handler = createHandler();
    const response = await handler.handle(new Request("http://localhost/_rpc/unknown.proc"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("should serve manifest", async () => {
    const handler = createHandler();
    const response = await handler.handle(new Request("http://localhost/_rpc/manifest.json"));
    expect(response.status).toBe(200);
    const manifest = await response.json();
    expect(manifest.procedures["greeting.hello"]).toBeDefined();
    expect(manifest.procedures["greeting.hello"].type).toBe("query");
    expect(manifest.procedures["math.add"].type).toBe("mutation");
  });

  it("should serve OpenAPI spec", async () => {
    const handler = createHandler();
    const response = await handler.handle(new Request("http://localhost/_rpc/openapi.json"));
    expect(response.status).toBe(200);
    const spec = await response.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Celsian RPC API");
    expect(spec.paths["/_rpc/greeting.hello"]).toBeDefined();
  });

  it("should run middleware chain", async () => {
    const order: string[] = [];

    const routes = router({
      test: procedure
        .use(async ({ next }) => {
          order.push("mw1");
          return next();
        })
        .use(async ({ next }) => {
          order.push("mw2");
          return next();
        })
        .query(async () => {
          order.push("handler");
          return { ok: true };
        }),
    });

    const handler = new RPCHandler(routes);
    await handler.handle(new Request("http://localhost/_rpc/test"));
    expect(order).toEqual(["mw1", "mw2", "handler"]);
  });

  it("should support custom context factory", async () => {
    const routes = router({
      whoami: procedure.query(async ({ ctx }) => {
        return { user: (ctx as any).user };
      }),
    });

    const handler = new RPCHandler(routes, {
      contextFactory: (request) => ({
        request,
        user: "admin",
      }),
    });

    const response = await handler.handle(new Request("http://localhost/_rpc/whoami"));
    const body = await response.json();
    expect(body.result).toEqual({ user: "admin" });
  });

  it("should support custom base path", async () => {
    const routes = router({
      ping: procedure.query(async () => ({ pong: true })),
    });

    const handler = new RPCHandler(routes, { basePath: "/api/rpc" });
    const response = await handler.handle(new Request("http://localhost/api/rpc/ping"));
    expect(response.status).toBe(200);
  });

  it("should handle errors in handlers", async () => {
    const routes = router({
      fail: procedure.query(async () => {
        throw new Error("Boom");
      }),
    });

    const handler = new RPCHandler(routes);
    const response = await handler.handle(new Request("http://localhost/_rpc/fail"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).toBe("Boom");
  });

  it("should validate input with schema", async () => {
    const zodLike = {
      safeParse(input: unknown) {
        if (typeof input === "object" && input !== null && "name" in input) {
          return { success: true, data: input };
        }
        return {
          success: false,
          error: { issues: [{ message: "name is required", path: ["name"] }] },
        };
      },
      parse(input: unknown) {
        return input;
      },
    };

    const routes = router({
      greet: procedure.input(zodLike).query(async ({ input }) => input),
    });

    const handler = new RPCHandler(routes);

    // Valid input
    const valid = await handler.handle(
      new Request("http://localhost/_rpc/greet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      }),
    );
    expect(valid.status).toBe(200);

    // Invalid input
    const invalid = await handler.handle(
      new Request("http://localhost/_rpc/greet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(invalid.status).toBe(400);
    const body = await invalid.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
