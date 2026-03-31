import type { InferOutput, StandardSchema } from "@celsian/schema";
import { describe, expectTypeOf, it } from "vitest";
import { createApp } from "../src/app.js";
import type { CelsianRequest, ExtractRouteParams, TypedCelsianRequest } from "../src/types.js";

// ─── ExtractRouteParams utility type tests ───

describe("ExtractRouteParams", () => {
  it("should extract a single param", () => {
    expectTypeOf<ExtractRouteParams<"/users/:id">>().toEqualTypeOf<{ id: string }>();
  });

  it("should extract multiple params", () => {
    expectTypeOf<ExtractRouteParams<"/users/:id/posts/:postId">>().toEqualTypeOf<{ id: string; postId: string }>();
  });

  it("should extract wildcard param", () => {
    expectTypeOf<ExtractRouteParams<"/static/*">>().toEqualTypeOf<{ "*": string }>();
  });

  it("should return empty object for no params", () => {
    expectTypeOf<ExtractRouteParams<"/no-params">>().toEqualTypeOf<{}>();
  });

  it("should handle root path", () => {
    expectTypeOf<ExtractRouteParams<"/">>().toEqualTypeOf<{}>();
  });

  it("should handle three params", () => {
    expectTypeOf<ExtractRouteParams<"/a/:x/b/:y/c/:z">>().toEqualTypeOf<{ x: string; y: string; z: string }>();
  });

  it("should handle param at the start", () => {
    expectTypeOf<ExtractRouteParams<"/:id">>().toEqualTypeOf<{ id: string }>();
  });
});

// ─── CelsianRequest generic param tests ───

describe("CelsianRequest generic params", () => {
  it("should default to Record<string, string>", () => {
    type DefaultReq = CelsianRequest;
    expectTypeOf<DefaultReq["params"]>().toEqualTypeOf<Record<string, string>>();
  });

  it("should accept a custom params type", () => {
    type CustomReq = CelsianRequest<{ id: string }>;
    expectTypeOf<CustomReq["params"]>().toEqualTypeOf<{ id: string }>();
  });
});

// ─── Route handler type inference tests ───

describe("Route handler type inference", () => {
  it("should infer single param from route string", () => {
    const app = createApp();
    app.get("/users/:id", (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ id: req.params.id });
    });
  });

  it("should infer multiple params from route string", () => {
    const app = createApp();
    app.get("/users/:id/posts/:postId", (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string; postId: string }>();
      return reply.json({ id: req.params.id, postId: req.params.postId });
    });
  });

  it("should infer wildcard param", () => {
    const app = createApp();
    app.get("/static/*", (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ "*": string }>();
      return reply.json({ path: req.params["*"] });
    });
  });

  it("should infer empty params for parameterless routes", () => {
    const app = createApp();
    app.get("/no-params", (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{}>();
      return reply.json({ ok: true });
    });
  });

  it("should work with POST routes", () => {
    const app = createApp();
    app.post("/users/:id", (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ id: req.params.id });
    });
  });

  it("should work with PUT routes", () => {
    const app = createApp();
    app.put("/users/:id", (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ id: req.params.id });
    });
  });

  it("should work with PATCH routes", () => {
    const app = createApp();
    app.patch("/users/:id", (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ id: req.params.id });
    });
  });

  it("should work with DELETE routes", () => {
    const app = createApp();
    app.delete("/users/:id", (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ id: req.params.id });
    });
  });

  it("should still allow accessing query and parsedBody", () => {
    const app = createApp();
    app.get("/users/:id", (req, reply) => {
      expectTypeOf(req.query).toEqualTypeOf<Record<string, string | string[]>>();
      expectTypeOf(req.parsedBody).toEqualTypeOf<unknown>();
      return reply.json({ ok: true });
    });
  });
});

// ─── Backwards compatibility tests ───

describe("Backwards compatibility", () => {
  it("should allow untyped CelsianRequest (default generic)", () => {
    // Simulate existing code that uses CelsianRequest without generics
    const handler = (req: CelsianRequest, _reply: any) => {
      // With default generic, params is Record<string, string>
      // Any string key access should work
      const _id: string = req.params.anything;
      const _name: string = req.params.whatever;
    };
    expectTypeOf(handler).toBeFunction();
  });

  it("should work with plugin context route methods", async () => {
    const app = createApp();
    await app.register(async (ctx) => {
      ctx.get("/items/:itemId", (req, reply) => {
        expectTypeOf(req.params).toEqualTypeOf<{ itemId: string }>();
        return reply.json({ itemId: req.params.itemId });
      });
    });
  });
});

// ─── InferOutput utility type tests ───

describe("InferOutput", () => {
  it("should infer output from StandardSchema", () => {
    type Result = InferOutput<StandardSchema<string, number>>;
    expectTypeOf<Result>().toEqualTypeOf<number>();
  });

  it("should infer output from _output phantom type", () => {
    type SchemaLike = { _output: { name: string; age: number } };
    type Result = InferOutput<SchemaLike>;
    expectTypeOf<Result>().toEqualTypeOf<{ name: string; age: number }>();
  });

  it("should infer output from _type phantom type (TypeBox-style)", () => {
    type TypeBoxLike = { _type: { id: string } };
    type Result = InferOutput<TypeBoxLike>;
    expectTypeOf<Result>().toEqualTypeOf<{ id: string }>();
  });

  it("should fall back to unknown for unrecognized schemas", () => {
    type Result = InferOutput<{ validate: () => void }>;
    expectTypeOf<Result>().toEqualTypeOf<unknown>();
  });
});

// ─── TypedCelsianRequest tests ───

describe("TypedCelsianRequest", () => {
  it("should type parsedBody", () => {
    type Req = TypedCelsianRequest<Record<string, string>, { name: string }>;
    expectTypeOf<Req["parsedBody"]>().toEqualTypeOf<{ name: string }>();
  });

  it("should type parsedQuery", () => {
    type Req = TypedCelsianRequest<Record<string, string>, unknown, { page: string }>;
    expectTypeOf<Req["parsedQuery"]>().toEqualTypeOf<{ page: string }>();
  });

  it("should type params", () => {
    type Req = TypedCelsianRequest<{ id: string }, unknown>;
    expectTypeOf<Req["params"]>().toEqualTypeOf<{ id: string }>();
  });
});

// ─── Schema-based route type inference tests ───

describe("Schema-based route type inference", () => {
  // Mock schema that looks like a Zod schema with _output phantom type
  type MockBodySchema = { _output: { name: string; email: string }; safeParse: unknown; parse: unknown };
  type MockQuerySchema = { _output: { page: string; limit: string }; safeParse: unknown; parse: unknown };

  it("should infer parsedBody type from schema.body", () => {
    const app = createApp();
    app.post(
      "/users",
      {
        schema: { body: {} as MockBodySchema },
      },
      (req, reply) => {
        expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
        return reply.json({ created: req.parsedBody.name });
      },
    );
  });

  it("should have unknown parsedBody without schema", () => {
    const app = createApp();
    app.post("/users", (req, reply) => {
      expectTypeOf(req.parsedBody).toEqualTypeOf<unknown>();
      return reply.json({ ok: true });
    });
  });

  it("should infer params from route string with schema", () => {
    const app = createApp();
    app.put(
      "/users/:id",
      {
        schema: { body: {} as MockBodySchema },
      },
      (req, reply) => {
        expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
        expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
        return reply.json({ id: req.params.id, name: req.parsedBody.name });
      },
    );
  });

  it("should work with PATCH method and schema", () => {
    const app = createApp();
    app.patch(
      "/items/:itemId",
      {
        schema: { body: {} as MockBodySchema },
      },
      (req, reply) => {
        expectTypeOf(req.params).toEqualTypeOf<{ itemId: string }>();
        expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
        return reply.json({ updated: true });
      },
    );
  });

  it("should work with DELETE method and schema", () => {
    const app = createApp();
    app.delete(
      "/items/:itemId",
      {
        schema: { body: {} as MockBodySchema },
      },
      (req, reply) => {
        expectTypeOf(req.params).toEqualTypeOf<{ itemId: string }>();
        return reply.json({ deleted: true });
      },
    );
  });

  it("should work with GET method and schema (for query)", () => {
    const app = createApp();
    app.get(
      "/search",
      {
        schema: {},
      },
      (req, reply) => {
        expectTypeOf(req.params).toEqualTypeOf<{}>();
        return reply.json({ ok: true });
      },
    );
  });

  it("should still infer params correctly from complex routes with schema", () => {
    const app = createApp();
    app.post(
      "/orgs/:orgId/teams/:teamId/members",
      {
        schema: { body: {} as MockBodySchema },
      },
      (req, reply) => {
        expectTypeOf(req.params).toEqualTypeOf<{ orgId: string; teamId: string }>();
        expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
        return reply.json({ ok: true });
      },
    );
  });

  it("old two-arg signature still compiles and works alongside new three-arg", () => {
    const app = createApp();
    // Old API — still works
    app.post("/old-way", (req, reply) => {
      expectTypeOf(req.parsedBody).toEqualTypeOf<unknown>();
      return reply.json({ ok: true });
    });
    // New API — typed
    app.post(
      "/new-way",
      {
        schema: { body: {} as MockBodySchema },
      },
      (req, reply) => {
        expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
        return reply.json({ ok: true });
      },
    );
  });

  it("should work in plugin context with schema overload", async () => {
    const app = createApp();
    await app.register(async (ctx) => {
      ctx.post(
        "/plugin-route/:id",
        {
          schema: { body: {} as MockBodySchema },
        },
        (req, reply) => {
          expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
          expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
          return reply.json({ ok: true });
        },
      );
    });
  });

  it("should handle schema with no body (empty schema object)", () => {
    const app = createApp();
    app.post(
      "/no-body-schema",
      {
        schema: {},
      },
      (req, reply) => {
        // No body schema means parsedBody stays unknown
        expectTypeOf(req.parsedBody).toEqualTypeOf<unknown>();
        return reply.json({ ok: true });
      },
    );
  });
});
