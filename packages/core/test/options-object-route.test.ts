// @celsian/core -- Tests for Fastify-style options-object route registration (CORE-03)

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { CelsianError } from "../src/errors.js";
import type { PluginContext, RouteHandler } from "../src/types.js";

describe("Options-object route registration (CORE-03)", () => {
  it("app.post(url, { handler }) registers and serves the handler", async () => {
    const app = createApp();
    app.post("/items", {
      handler: (_req, reply) => reply.json({ created: true }),
    });

    const res = await app.inject({ method: "POST", url: "/items" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true });
  });

  it("app.post(url, { schema, handler }) parses the body and serves", async () => {
    const app = createApp();
    app.post("/echo", {
      schema: {},
      handler: (req, reply) => reply.json({ body: req.parsedBody }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/echo",
      payload: { a: 1 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: { a: 1 } });
  });

  it("works for get/put/patch/delete too", async () => {
    const app = createApp();
    app.get("/r", { handler: (_req, reply) => reply.json({ m: "GET" }) });
    app.put("/r", { handler: (_req, reply) => reply.json({ m: "PUT" }) });
    app.patch("/r", { handler: (_req, reply) => reply.json({ m: "PATCH" }) });
    app.delete("/r", { handler: (_req, reply) => reply.json({ m: "DELETE" }) });

    for (const method of ["GET", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/r" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ m: method });
    }
  });

  it("trailing handler argument takes precedence over opts.handler", async () => {
    const app = createApp();
    app.post("/which", { handler: (_req, reply) => reply.json({ from: "opts" }) }, (_req, reply) =>
      reply.json({ from: "arg" }),
    );

    const res = await app.inject({ method: "POST", url: "/which" });
    expect(await res.json()).toEqual({ from: "arg" });
  });

  it("opts.preHandler hooks are honored with options-object registration", async () => {
    const app = createApp();
    const seen: string[] = [];
    app.post("/hooked", {
      preHandler: () => {
        seen.push("preHandler");
      },
      handler: (_req, reply) => reply.json({ ok: true }),
    });

    const res = await app.inject({ method: "POST", url: "/hooked" });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["preHandler"]);
  });

  it("throws a CelsianError at registration time when no handler is resolvable", () => {
    const app = createApp();
    expect(() => app.post("/broken", { schema: {} } as never)).toThrow(CelsianError);
    expect(() => app.post("/broken", { schema: {} } as never)).toThrow(/no handler/i);
  });

  it("plugin context route methods also support { handler } and fail fast without one", async () => {
    const app = createApp();
    await app.register(async (ctx: PluginContext) => {
      ctx.post("/plugin-route", {
        handler: ((_req, reply) => reply.json({ plugin: true })) as RouteHandler,
      });
      expect(() => ctx.post("/plugin-broken", {} as never)).toThrow(CelsianError);
    });

    const res = await app.inject({ method: "POST", url: "/plugin-route" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plugin: true });
  });
});
