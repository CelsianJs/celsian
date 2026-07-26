import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";

// ─── TASK-1.6: schema.response is declared AND enforced ───

describe("response schema validation", () => {
  it("passes through a response that matches the schema for its status code", async () => {
    const app = createApp();
    app.route({
      method: "GET",
      url: "/ok",
      schema: { response: { 200: z.object({ must: z.string() }) } },
      handler: (_req, reply) => reply.json({ must: "here" }),
    });

    const res = await app.inject({ url: "/ok" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ must: "here" });
  });

  it("returns a generic 500 when the response does not match the schema", async () => {
    const app = createApp();
    app.route({
      method: "GET",
      url: "/bad",
      schema: { response: { 200: z.object({ must: z.string() }) } },
      handler: (_req, reply) => reply.json({ wrong: 123 }),
    });

    const res = await app.inject({ url: "/bad" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Internal Server Error",
      statusCode: 500,
      code: "RESPONSE_VALIDATION_FAILED",
    });
  });

  it("never echoes the offending payload back to the client", async () => {
    const app = createApp();
    app.route({
      method: "GET",
      url: "/leaky",
      schema: { response: { 200: z.object({ must: z.string() }) } },
      handler: (_req, reply) => reply.json({ internalSecret: "hunter2" }),
    });

    const body = await (await app.inject({ url: "/leaky" })).text();
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("internalSecret");
  });

  it("validates auto-serialized return values, not just explicit replies", async () => {
    const app = createApp();
    app.route({
      method: "GET",
      url: "/returned",
      schema: { response: { 200: z.object({ must: z.string() }) } },
      handler: () => ({ wrong: 123 }),
    });

    expect((await app.inject({ url: "/returned" })).status).toBe(500);
  });

  it("looks the schema up by status code", async () => {
    const app = createApp();
    app.route({
      method: "GET",
      url: "/created",
      schema: {
        response: {
          200: z.object({ never: z.string() }),
          201: z.object({ id: z.number() }),
        },
      },
      handler: (_req, reply) => reply.status(201).json({ id: 7 }),
    });

    const res = await app.inject({ url: "/created" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 7 });
  });

  it("falls back to the `default` entry for statuses without an explicit schema", async () => {
    const app = createApp();
    app.route({
      method: "GET",
      url: "/fallback",
      schema: { response: { default: z.object({ id: z.number() }) } },
      handler: (_req, reply) => reply.status(202).json({ id: "not-a-number" }),
    });

    expect((await app.inject({ url: "/fallback" })).status).toBe(500);
  });

  it("leaves a status with no matching schema alone", async () => {
    const app = createApp();
    app.route({
      method: "GET",
      url: "/unchecked",
      schema: { response: { 200: z.object({ must: z.string() }) } },
      handler: (_req, reply) => reply.status(418).json({ anything: true }),
    });

    const res = await app.inject({ url: "/unchecked" });
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ anything: true });
  });

  it("leaves routes without a response schema untouched", async () => {
    const app = createApp();
    app.get("/no-schema", () => ({ anything: 123 }));

    const res = await app.inject({ url: "/no-schema" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ anything: 123 });
  });

  it("can be disabled with validateResponses: false", async () => {
    const app = createApp({ validateResponses: false });
    app.route({
      method: "GET",
      url: "/bad",
      schema: { response: { 200: z.object({ must: z.string() }) } },
      handler: (_req, reply) => reply.json({ wrong: 123 }),
    });

    const res = await app.inject({ url: "/bad" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wrong: 123 });
  });

  it("does not try to validate non-JSON bodies", async () => {
    const app = createApp();
    app.route({
      method: "GET",
      url: "/text",
      schema: { response: { 200: z.object({ must: z.string() }) } },
      handler: (_req, reply) => reply.html("<p>hi</p>"),
    });

    const res = await app.inject({ url: "/text" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>hi</p>");
  });
});

// ─── TASK-1.7 / M-11: validated query and params must reach the handler ───

describe("validated querystring and params reach the request", () => {
  it("exposes coerced querystring output on request.query", async () => {
    const app = createApp();
    let seen: unknown;

    app.route({
      method: "GET",
      url: "/q",
      schema: { querystring: z.object({ page: z.coerce.number() }) },
      handler: (req, reply) => {
        seen = req.query;
        return reply.json({ ok: true });
      },
    });

    await app.inject({ url: "/q?page=3" });
    expect(seen).toEqual({ page: 3 });
  });

  it("strips unknown querystring keys from request.query", async () => {
    const app = createApp();
    let seen: unknown;

    app.route({
      method: "GET",
      url: "/q",
      schema: { querystring: z.object({ page: z.coerce.number() }) },
      handler: (req, reply) => {
        seen = req.query;
        return reply.json({ ok: true });
      },
    });

    await app.inject({ url: "/q?page=3&evil=payload" });
    expect(seen).toEqual({ page: 3 });
    expect((seen as Record<string, unknown>).evil).toBeUndefined();
  });

  it("keeps parsedQuery as an alias of the validated output", async () => {
    const app = createApp();
    let query: unknown;
    let parsedQuery: unknown;

    app.route({
      method: "GET",
      url: "/q",
      schema: { querystring: z.object({ page: z.coerce.number() }) },
      handler: (req, reply) => {
        query = req.query;
        parsedQuery = req.parsedQuery;
        return reply.json({ ok: true });
      },
    });

    await app.inject({ url: "/q?page=3" });
    expect(parsedQuery).toEqual({ page: 3 });
    expect(parsedQuery).toBe(query);
  });

  it("exposes coerced params output on request.params", async () => {
    const app = createApp();
    let seen: unknown;

    app.route({
      method: "GET",
      url: "/users/:id",
      schema: { params: z.object({ id: z.coerce.number() }) },
      handler: (req, reply) => {
        seen = req.params;
        return reply.json({ ok: true });
      },
    });

    await app.inject({ url: "/users/42" });
    expect(seen).toEqual({ id: 42 });
  });

  it("leaves request.query untouched when no querystring schema is declared", async () => {
    const app = createApp();
    let seen: unknown;

    app.get("/raw", (req, reply) => {
      seen = { ...req.query };
      return reply.json({ ok: true });
    });

    await app.inject({ url: "/raw?page=3&extra=keep" });
    expect(seen).toEqual({ page: "3", extra: "keep" });
  });
});
