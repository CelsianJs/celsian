// @celsian/core -- a route's schema adapters are built once, at registration
//
// validateRequest() used to call fromSchema() for the body, the querystring and
// the params of every request, and validateResponse() for every response,
// building a fresh adapter object each time from a schema that never changes.
// The adapters are now built when the route is registered. Validation itself,
// and what happens with a schema that cannot be adapted, are unchanged.

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import {
  compileRouteValidators,
  ROUTE_VALIDATORS,
  type RouteWithValidators,
  validatorFor,
} from "../src/route-validators.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A Zod-shaped schema that counts how often it is adapted and how often it validates. */
function countingSchema() {
  const calls = { adapted: 0, validated: 0 };
  const schema = {
    // fromSchema() asks every candidate whether it is already an adapter, by
    // reading `validate`, exactly once per adaptation. Nothing else reads it.
    get validate() {
      calls.adapted++;
      return undefined;
    },
    safeParse(input: unknown) {
      calls.validated++;
      return { success: true, data: input };
    },
    parse: (input: unknown) => input,
  };
  return { schema, calls };
}

describe("route schema adapters", () => {
  it("are built at registration and reused by every request", async () => {
    const body = countingSchema();
    const query = countingSchema();
    const params = countingSchema();
    const response = countingSchema();
    const app = createApp();
    app.post(
      "/things/:id",
      {
        schema: {
          body: body.schema,
          querystring: query.schema,
          params: params.schema,
          response: { 200: response.schema },
        },
      },
      (req) => ({ got: req.parsedBody }),
    );
    const adaptedAtRegistration = [body, query, params, response].map((s) => s.calls.adapted);
    expect(adaptedAtRegistration).toEqual([1, 1, 1, 1]);

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/things/7?x=1", payload: { n: i } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ got: { n: i } });
    }

    // Nothing was adapted again by the five requests...
    expect([body, query, params, response].map((s) => s.calls.adapted)).toEqual(adaptedAtRegistration);
    // ...and each schema still validated every one of them.
    expect([body, query, params, response].map((s) => s.calls.validated)).toEqual([5, 5, 5, 5]);
  });

  it("validate, coerce and strip exactly as before", async () => {
    const app = createApp();
    app.post(
      "/users/:id",
      {
        schema: {
          params: z.object({ id: z.coerce.number() }),
          querystring: z.object({ verbose: z.enum(["0", "1"]).default("0") }),
          body: z.object({ name: z.string().min(1) }),
          response: { 201: z.object({ id: z.number(), name: z.string() }) },
        },
      },
      (req, reply) => reply.status(201).json({ id: req.params.id, name: (req.parsedBody as { name: string }).name }),
    );

    const ok = await app.inject({ method: "POST", url: "/users/12", payload: { name: "Ada", extra: "dropped" } });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ id: 12, name: "Ada" });

    const bad = await app.inject({ method: "POST", url: "/users/12", payload: { name: "" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "Validation failed", statusCode: 400 });

    const badQuery = await app.inject({ method: "POST", url: "/users/12?verbose=maybe", payload: { name: "Ada" } });
    expect(badQuery.status).toBe(400);
  });

  it("registers a route whose schema cannot be adapted, and fails each request to it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp();
    // Registration has never rejected an unsupported schema; the request does.
    expect(() => app.post("/bad", { schema: { body: { not: "a schema" } } }, () => ({ ok: true }))).not.toThrow();

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "POST", url: "/bad", payload: { a: 1 } });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toContain("Unsupported schema");
    }
  });

  it("follows a schema replaced on the route after registration", async () => {
    const app = createApp();
    app.post("/x", { schema: { body: z.object({ a: z.number() }) } }, (req) => ({ got: req.parsedBody }));
    expect((await app.inject({ method: "POST", url: "/x", payload: { a: "text" } })).status).toBe(400);

    const route = app.getRoutes().find((r) => r.url === "/x");
    (route?.schema as { body: unknown }).body = z.object({ a: z.string() });

    const res = await app.inject({ method: "POST", url: "/x", payload: { a: "text" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { a: "text" } });
  });

  it("does not add anything visible to the route object", () => {
    const app = createApp();
    const schema = { body: z.object({ a: z.number() }) };
    app.post("/x", { schema }, () => ({ ok: true }));
    app.get("/plain", () => ({ ok: true }));

    const [withSchema, plain] = ["/x", "/plain"].map((url) => app.getRoutes().find((r) => r.url === url));
    expect(Object.keys(withSchema as object)).toEqual(Object.keys(plain as object));
    expect(withSchema?.schema).toBe(schema);
    expect(Object.getOwnPropertySymbols(plain as object)).toEqual([]);
    expect((withSchema as RouteWithValidators)[ROUTE_VALIDATORS]?.body?.raw).toBe(schema.body);
    expect(Object.keys({ ...withSchema })).toEqual(Object.keys(plain as object));
    expect(Object.getOwnPropertySymbols({ ...withSchema })).toEqual([]);
  });

  it("adapts every entry of a status-keyed response map, and a bare response schema", () => {
    const ok = z.object({ ok: z.boolean() });
    const fallback = z.object({ error: z.string() });
    const keyed = compileRouteValidators({ response: { 200: ok, default: fallback } });
    expect([...keyed.responses.keys()]).toEqual([ok, fallback]);

    const bare = compileRouteValidators({ response: ok });
    expect([...bare.responses.keys()]).toEqual([ok]);

    const none = compileRouteValidators({});
    expect(none.body).toBeUndefined();
    expect(none.responses.size).toBe(0);
  });

  it("hands back the registered adapter only for the schema it was built from", () => {
    const first = z.object({ a: z.number() });
    const second = z.object({ a: z.string() });
    const compiled = compileRouteValidators({ body: first });

    expect(validatorFor(compiled.body, first)).toBe(compiled.body?.adapter);
    expect(validatorFor(compiled.body, first)).toBe(validatorFor(compiled.body, first));
    const other = validatorFor(compiled.body, second);
    expect(other).not.toBe(compiled.body?.adapter);
    expect(other.validate({ a: "x" }).success).toBe(true);
  });
});
