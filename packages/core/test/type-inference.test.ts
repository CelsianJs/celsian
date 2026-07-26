import type { InferOutput, StandardSchema } from "@celsian/schema";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import type { CelsianRequest, ExtractRouteParams, InferQuery, TypedCelsianRequest } from "../src/types.js";

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

// ─── app.route() typed schema inference tests ───

describe("app.route() typed schema inference", () => {
  type MockBodySchema = { _output: { name: string; email: string }; safeParse: unknown; parse: unknown };

  it("route() with schema.body infers parsedBody type", () => {
    const app = createApp();
    app.route({
      method: "POST",
      url: "/users",
      schema: { body: {} as MockBodySchema },
      handler(req, reply) {
        expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
        return reply.json(req.parsedBody);
      },
    });
  });

  it("route() without schema keeps parsedBody as unknown", () => {
    const app = createApp();
    app.route({
      method: "GET",
      url: "/users",
      handler(req, reply) {
        expectTypeOf(req.parsedBody).toEqualTypeOf<unknown>();
        return reply.json({});
      },
    });
  });

  it("route() with schema.body works with PUT method", () => {
    const app = createApp();
    app.route({
      method: "PUT",
      url: "/users",
      schema: { body: {} as MockBodySchema },
      handler(req, reply) {
        expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
        return reply.json({ updated: req.parsedBody.name });
      },
    });
  });

  it("route() with schema.body works with multiple methods", () => {
    const app = createApp();
    app.route({
      method: ["POST", "PUT"],
      url: "/users",
      schema: { body: {} as MockBodySchema },
      handler(req, reply) {
        expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
        return reply.json({ ok: true });
      },
    });
  });

  it("route() with kind option still infers types", () => {
    const app = createApp();
    app.route({
      method: "POST",
      url: "/users",
      kind: "serverless",
      schema: { body: {} as MockBodySchema },
      handler(req, reply) {
        expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
        return reply.json({ ok: true });
      },
    });
  });

  it("route() with hooks and schema still infers types", () => {
    const app = createApp();
    app.route({
      method: "POST",
      url: "/users",
      schema: { body: {} as MockBodySchema },
      onRequest: (_req, _reply) => {},
      preHandler: (_req, _reply) => {},
      handler(req, reply) {
        expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
        return reply.json({ ok: true });
      },
    });
  });
});

// ─── parsedBody + parsedQuery across every registration form (real Zod schemas) ───
//
// These assertions guard TASK-1.8: the CelsianApp route-method overloads used to
// declare TBody/TQuery and then never reference them, and the query type was
// written as `TQuery extends unknown ? raw : InferOutput<TQuery>` — always true,
// so the typed branch was unreachable and no schema could ever type parsedQuery.

describe("parsedBody and parsedQuery inference (Zod)", () => {
  const Body = z.object({ name: z.string(), age: z.number() });
  const Query = z.object({ page: z.coerce.number(), tag: z.string() });

  type BodyOut = { name: string; age: number };
  type QueryOut = { page: number; tag: string };
  type RawQuery = Record<string, string | string[]>;

  it("app.post(path, opts, handler) types both parsedBody and parsedQuery", () => {
    const app = createApp();
    app.post("/users/:id", { schema: { body: Body, querystring: Query } }, (req, reply) => {
      expectTypeOf(req.parsedBody).toEqualTypeOf<BodyOut>();
      expectTypeOf(req.parsedQuery).toEqualTypeOf<QueryOut>();
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ ok: true });
    });
  });

  it("app.post(path, { schema, handler }) types both parsedBody and parsedQuery", () => {
    const app = createApp();
    app.post("/users/:id", {
      schema: { body: Body, querystring: Query },
      handler(req, reply) {
        expectTypeOf(req.parsedBody).toEqualTypeOf<BodyOut>();
        expectTypeOf(req.parsedQuery).toEqualTypeOf<QueryOut>();
        expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
        return reply.json({ ok: true });
      },
    });
  });

  it("app.route({ ... }) types both parsedBody and parsedQuery", () => {
    const app = createApp();
    app.route({
      method: "POST",
      url: "/users",
      schema: { body: Body, querystring: Query },
      handler(req, reply) {
        expectTypeOf(req.parsedBody).toEqualTypeOf<BodyOut>();
        expectTypeOf(req.parsedQuery).toEqualTypeOf<QueryOut>();
        return reply.json({ ok: true });
      },
    });
  });

  it("the plugin form types both parsedBody and parsedQuery", async () => {
    const app = createApp();
    await app.register(async (ctx) => {
      ctx.post("/plugin/:id", { schema: { body: Body, querystring: Query } }, (req, reply) => {
        expectTypeOf(req.parsedBody).toEqualTypeOf<BodyOut>();
        expectTypeOf(req.parsedQuery).toEqualTypeOf<QueryOut>();
        expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
        return reply.json({ ok: true });
      });
      ctx.route({
        method: "PUT",
        url: "/plugin-route",
        schema: { body: Body, querystring: Query },
        handler(req, reply) {
          expectTypeOf(req.parsedBody).toEqualTypeOf<BodyOut>();
          expectTypeOf(req.parsedQuery).toEqualTypeOf<QueryOut>();
          return reply.json({ ok: true });
        },
      });
    });
  });

  it("falls back to the raw string record when no querystring schema is given", () => {
    const app = createApp();
    app.post("/body-only", { schema: { body: Body } }, (req, reply) => {
      expectTypeOf(req.parsedBody).toEqualTypeOf<BodyOut>();
      expectTypeOf(req.parsedQuery).toEqualTypeOf<RawQuery>();
      return reply.json({ ok: true });
    });
  });

  it("types parsedQuery with a querystring schema and no body schema", () => {
    const app = createApp();
    app.get("/search", { schema: { querystring: Query } }, (req, reply) => {
      expectTypeOf(req.parsedQuery).toEqualTypeOf<QueryOut>();
      return reply.json({ ok: true });
    });
  });

  it("types parsedBody on every verb", () => {
    const app = createApp();
    app.put("/p", { schema: { body: Body } }, (req) => {
      expectTypeOf(req.parsedBody).toEqualTypeOf<BodyOut>();
    });
    app.patch("/p", { schema: { body: Body } }, (req) => {
      expectTypeOf(req.parsedBody).toEqualTypeOf<BodyOut>();
    });
    app.delete("/p", { schema: { body: Body } }, (req) => {
      expectTypeOf(req.parsedBody).toEqualTypeOf<BodyOut>();
    });
  });

  it("InferQuery resolves the schema output, not the raw record", () => {
    expectTypeOf<InferQuery<typeof Query>>().toEqualTypeOf<QueryOut>();
    expectTypeOf<InferQuery<unknown>>().toEqualTypeOf<RawQuery>();
  });
});

// ─── Handlers may return serializable data, not just Response ───

describe("RouteHandler return types", () => {
  it("accepts plain data, strings, Response, void and promises", () => {
    const app = createApp();
    app.get("/object", () => ({ message: "world" }));
    app.get("/string", () => "plain text");
    app.get("/array", () => [1, 2, 3]);
    app.get("/response", () => new Response("hi"));
    app.get("/void", () => {});
    app.get("/async-object", async () => ({ message: "world" }));
    expectTypeOf(app.get).toBeFunction();
  });
});
