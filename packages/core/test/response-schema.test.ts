// @celsian/core, `schema.response` in both of its spellings
//
// The bug this guards: `response: MySchema`, the spelling that mirrors
// `schema.body` and `schema.querystring`, was IGNORED entirely. Only the
// status-keyed `{ 200: MySchema }` form validated anything. A route whose
// response schema forbade extra keys returned `200 {"id":"1","leaked":"secret"}`
// with no error and no log line. A brand-new safety feature that no-ops on its
// most natural spelling is worse than not having the feature at all.
//
// The second bug: `schemas[status] ?? schemas.default` read `default` off the
// PROTOTYPE chain, and a Zod schema carries a bound `.default()` method. So a
// bare Zod schema in the map position handed a function to the schema adapter
// and 500'd with `SchemaError: Unsupported schema: received a function (bound
// default)`. That was a live 500 in docs/migration-from-fastify.md.

import { Type } from "@sinclair/typebox";
import * as v from "valibot";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { isStatusKeyedResponseMap, resolveResponseSchema } from "../src/response-schema.js";

const Strict = z.object({ id: z.string() }).strict();

describe("bare schema.response", () => {
  it("validates a 2xx body against a bare Zod schema and rejects a leak", async () => {
    const app = createApp();
    app.get("/leaky", { schema: { response: Strict } }, () => ({ id: "1", leaked: "secret" }));

    const res = await app.inject({ method: "GET", url: "/leaky" });

    expect(res.status).toBe(500);
    const body = await res.json();
    // The specific code matters: before the fix this route ALSO 500'd, but for
    // the wrong reason. The `?? schemas.default` lookup picked up Zod's bound
    // `.default()` method off the prototype and the adapter threw
    // `SchemaError: Unsupported schema: received a function (bound default)`,
    // producing a generic 500. Asserting the code proves the schema actually ran.
    expect(body).toMatchObject({ code: "RESPONSE_VALIDATION_FAILED" });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("passes a conforming body straight through", async () => {
    const app = createApp();
    app.get("/clean", { schema: { response: Strict } }, () => ({ id: "1" }));

    const res = await app.inject({ method: "GET", url: "/clean" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "1" });
  });

  it("validates a body the handler built itself with reply.json()", async () => {
    const app = createApp();
    app.get("/reply-json", { schema: { response: Strict } }, (_req, reply) =>
      reply.json({ id: "1", leaked: "secret" }),
    );

    const res = await app.inject({ method: "GET", url: "/reply-json" });

    expect(res.status).toBe(500);
  });

  it("works with a bare TypeBox schema", async () => {
    const app = createApp();
    app.get("/tb", { schema: { response: Type.Object({ id: Type.String() }) } }, () => ({ id: 42 }));

    const res = await app.inject({ method: "GET", url: "/tb" });

    expect(res.status).toBe(500);
  });

  it("works with a bare Valibot schema", async () => {
    const app = createApp();
    app.get("/vb", { schema: { response: v.object({ id: v.string() }) } }, () => ({ id: 42 }));

    const res = await app.inject({ method: "GET", url: "/vb" });

    expect(res.status).toBe(500);
  });

  it("does NOT apply a bare schema to error responses", async () => {
    // A bare schema describes the success payload. Treating it as `default`
    // would run it against 4xx/5xx bodies too and turn every 404 into a 500.
    const app = createApp();
    app.get("/missing", { schema: { response: Strict } }, (_req, reply) => reply.notFound("nope"));

    const res = await app.inject({ method: "GET", url: "/missing" });

    expect(res.status).toBe(404);
  });
});

describe("status-keyed schema.response", () => {
  it("still validates the exact status entry", async () => {
    const app = createApp();
    app.get("/keyed", { schema: { response: { 200: Strict } } }, () => ({ id: "1", leaked: "secret" }));

    const res = await app.inject({ method: "GET", url: "/keyed" });

    expect(res.status).toBe(500);
  });

  it("falls back to an explicit `default` entry", async () => {
    const app = createApp();
    app.get("/def", { schema: { response: { default: Strict } } }, () => ({ id: "1", leaked: "secret" }));

    const res = await app.inject({ method: "GET", url: "/def" });

    expect(res.status).toBe(500);
  });

  it("prefers the exact status entry over `default`", async () => {
    const app = createApp();
    app.get("/both", { schema: { response: { 200: z.object({ ok: z.boolean() }), default: Strict } } }, () => ({
      ok: true,
    }));

    const res = await app.inject({ method: "GET", url: "/both" });

    expect(res.status).toBe(200);
  });

  it("ignores a status with no entry and no default", async () => {
    const app = createApp();
    app.get("/201-only", { schema: { response: { 201: Strict } } }, () => ({ anything: true }));

    const res = await app.inject({ method: "GET", url: "/201-only" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ anything: true });
  });
});

describe("resolveResponseSchema", () => {
  it("never reads a schema method off the prototype chain as `default`", () => {
    // `Strict.default` is Zod's bound method. `schemas[200] ?? schemas.default`
    // returned it, which is not a schema, and the adapter threw.
    expect(typeof (Strict as unknown as { default: unknown }).default).toBe("function");
    expect(resolveResponseSchema({ 201: Strict }, 200)).toBeUndefined();
  });

  it("classifies each supported schema library as a bare schema, not a status map", () => {
    expect(isStatusKeyedResponseMap(Strict)).toBe(false);
    expect(isStatusKeyedResponseMap(Type.Object({ id: Type.String() }))).toBe(false);
    expect(isStatusKeyedResponseMap(v.object({ id: v.string() }))).toBe(false);
    expect(isStatusKeyedResponseMap({ validate: () => ({ success: true }), toJsonSchema: () => ({}) })).toBe(false);
  });

  it("classifies status-keyed objects as maps", () => {
    expect(isStatusKeyedResponseMap({ 200: Strict })).toBe(true);
    expect(isStatusKeyedResponseMap({ 200: Strict, default: Strict })).toBe(true);
    expect(isStatusKeyedResponseMap({ default: Strict })).toBe(true);
    expect(isStatusKeyedResponseMap({})).toBe(true);
  });

  it("scopes a bare schema to 2xx", () => {
    expect(resolveResponseSchema(Strict, 200)).toBe(Strict);
    expect(resolveResponseSchema(Strict, 299)).toBe(Strict);
    expect(resolveResponseSchema(Strict, 302)).toBeUndefined();
    expect(resolveResponseSchema(Strict, 404)).toBeUndefined();
    expect(resolveResponseSchema(Strict, 500)).toBeUndefined();
  });
});

describe("schema.response types", () => {
  it("accepts both spellings without a cast", () => {
    const app = createApp();
    // Both of these must compile. The bare form used to be the one that
    // silently did nothing, so it is the one worth asserting on.
    app.get("/t1", { schema: { response: Strict } }, () => ({ id: "1" }));
    app.get("/t2", { schema: { response: { 200: Strict, default: Strict } } }, () => ({ id: "1" }));
    expectTypeOf(app.get).toBeFunction();
  });
});
