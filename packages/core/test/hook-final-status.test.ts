// @celsian/core, onSend and onResponse see the status that is actually sent
//
// Access logs and metrics are built on these two hooks, so `reply.statusCode`
// must equal the final Response's status whichever path produced it: a reply
// helper, a Response the handler built itself, a thrown error, a 404/405 miss,
// a timeout, or a hook that answered early. `onResponse` must also run for
// every one of those, exactly once per request.

import { afterEach, describe, expect, it } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { HttpError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import type { CelsianAppOptions } from "../src/types.js";
import { startServer, type TestServer } from "./helpers/raw-http.js";

interface Observed {
  onSend: number[];
  onResponse: number[];
}

/** An app whose root onSend/onResponse hooks record the status they were shown. */
function observedApp(options: CelsianAppOptions = {}): { app: CelsianApp; seen: Observed } {
  const app = createApp(options);
  const seen: Observed = { onSend: [], onResponse: [] };
  app.addHook("onSend", (_req, reply) => {
    seen.onSend.push(reply.statusCode);
  });
  app.addHook("onResponse", (_req, reply) => {
    seen.onResponse.push(reply.statusCode);
  });
  return { app, seen };
}

/** onResponse is fire-and-forget; let any queued work settle before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const variants: Array<[string, CelsianAppOptions]> = [
  ["without a logger", {}],
  ["with a logger", { logger: createLogger({ destination: () => {} }) }],
];

describe.each(variants)("hook status %s", (_label, options) => {
  it("reply.status(202).json(...) is seen as 202 by both hooks", async () => {
    const { app, seen } = observedApp(options);
    app.get("/accepted", (_req, reply) => reply.status(202).json({ queued: true }));

    const res = await app.inject({ url: "/accepted" });
    await settle();

    expect(res.status).toBe(202);
    expect(seen).toEqual({ onSend: [202], onResponse: [202] });
  });

  it("a Response built by the handler is seen with its own status", async () => {
    const { app, seen } = observedApp(options);
    app.get("/limited", () => new Response("x", { status: 429 }));

    const res = await app.inject({ url: "/limited" });
    await settle();

    expect(res.status).toBe(429);
    expect(seen).toEqual({ onSend: [429], onResponse: [429] });
  });

  it("a thrown error is seen as 500 and still reaches onResponse", async () => {
    const { app, seen } = observedApp(options);
    app.get("/boom", () => {
      throw new Error("boom");
    });

    const res = await app.inject({ url: "/boom" });
    await settle();

    expect(res.status).toBe(500);
    expect(seen).toEqual({ onSend: [500], onResponse: [500] });
  });

  it("a thrown HttpError is seen with its own status", async () => {
    const { app, seen } = observedApp(options);
    app.get("/teapot", () => {
      throw new HttpError(418, "I'm a teapot");
    });

    const res = await app.inject({ url: "/teapot" });
    await settle();

    expect(res.status).toBe(418);
    expect(seen).toEqual({ onSend: [418], onResponse: [418] });
  });

  it("a custom error handler's Response is seen with its status", async () => {
    const { app, seen } = observedApp(options);
    app.setErrorHandler(() => new Response("down", { status: 503 }));
    app.get("/down", () => {
      throw new Error("db unavailable");
    });

    const res = await app.inject({ url: "/down" });
    await settle();

    expect(res.status).toBe(503);
    expect(seen).toEqual({ onSend: [503], onResponse: [503] });
  });

  it("a 404 miss is seen as 404 and reaches onResponse", async () => {
    const { app, seen } = observedApp(options);
    app.get("/exists", () => ({ ok: true }));

    const res = await app.inject({ url: "/nope" });
    await settle();

    expect(res.status).toBe(404);
    expect(seen).toEqual({ onSend: [404], onResponse: [404] });
  });

  it("a 405 miss is seen as 405 and reaches onResponse", async () => {
    const { app, seen } = observedApp(options);
    app.get("/only-get", () => ({ ok: true }));

    const res = await app.inject({ method: "DELETE", url: "/only-get" });
    await settle();

    expect(res.status).toBe(405);
    expect(seen).toEqual({ onSend: [405], onResponse: [405] });
  });

  it("a custom not-found handler's Response is seen with its status", async () => {
    const { app, seen } = observedApp(options);
    app.setNotFoundHandler(() => new Response("gone", { status: 410 }));

    const res = await app.inject({ url: "/old" });
    await settle();

    expect(res.status).toBe(410);
    expect(seen).toEqual({ onSend: [410], onResponse: [410] });
  });

  it("an onRequest hook that answers early is seen by onResponse with its status", async () => {
    const { app, seen } = observedApp(options);
    app.addHook("onRequest", () => new Response(null, { status: 401 }));
    app.get("/private", () => ({ secret: true }));

    const res = await app.inject({ url: "/private" });
    await settle();

    expect(res.status).toBe(401);
    expect(seen.onResponse).toEqual([401]);
  });

  it("a preHandler hook that answers early through the reply is seen by onResponse", async () => {
    const { app, seen } = observedApp(options);
    app.addHook("preHandler", (_req, reply) => reply.status(403).json({ error: "Forbidden" }));
    app.get("/admin", () => ({ admin: true }));

    const res = await app.inject({ url: "/admin" });
    await settle();

    expect(res.status).toBe(403);
    expect(seen.onResponse).toEqual([403]);
  });

  it("an onRequest hook that answers early on an unrouted path is seen by onResponse", async () => {
    const { app, seen } = observedApp(options);
    app.addHook("onRequest", () => new Response(null, { status: 401 }));

    const res = await app.inject({ url: "/admin/nothing-here" });
    await settle();

    expect(res.status).toBe(401);
    expect(seen.onResponse).toEqual([401]);
  });

  it("a request timeout is seen as 504, and onResponse runs once even after the handler finishes", async () => {
    const { app, seen } = observedApp({ ...options, requestTimeout: 20 });
    let finished = false;
    app.get("/slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      finished = true;
      return { late: true };
    });

    const res = await app.inject({ url: "/slow" });
    await settle();
    expect(res.status).toBe(504);
    expect(seen.onResponse).toEqual([504]);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(finished).toBe(true);
    expect(seen.onResponse).toEqual([504]);
  });
});

describe("hook status over a real socket", () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close();
  });

  it("reports the status that went on the wire for every path", async () => {
    const { app, seen } = observedApp();
    app.get("/limited", () => new Response("x", { status: 429 }));
    app.get("/boom", () => {
      throw new Error("boom");
    });
    app.get("/private", {
      onRequest: [() => new Response(null, { status: 401 })],
      handler: () => ({ secret: true }),
    });
    const server = await startServer(app);
    servers.push(server);

    const wire: number[] = [];
    for (const path of ["/limited", "/boom", "/nope", "/private"]) {
      wire.push((await server.send({ path })).status);
    }
    await settle();

    expect(wire).toEqual([429, 500, 404, 401]);
    expect(seen.onResponse).toEqual(wire);
    // An early return still skips onSend, so it contributes no entry there.
    expect(seen.onSend).toEqual([429, 500, 404]);
  });
});
