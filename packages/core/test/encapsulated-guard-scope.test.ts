// @celsian/core, guards registered under a prefix must gate unrouted requests too
//
// Root cause: two code paths resolved hooks from the ROOT scope only, so a
// plugin registered with `{ prefix }` -- which lives in a child encapsulation
// context -- was invisible to them.
//
//  1. `app.getUpgradeHooks()` gated WebSocket handshakes. With the identical
//     auth plugin, only the prefix differing:
//       register(chatPlugin)               -> handshake without auth: 401 Rejected
//       register(chatPlugin, {prefix:'/api'}) -> handshake without auth: 101 Switching
//     That 101 is an authentication bypass, and it is the exact symptom the
//     gate's own docblock claimed to have fixed ("however they were registered").
//
//  2. The 405 branch runs `onRequest` hooks before emitting `Allow`. Running only
//     root-scope hooks meant:
//       GET  /admin/users/1 -> 401 (the encapsulated guard works)
//       POST /admin/users/1 -> 405 Allow: "GET, HEAD, PUT, DELETE"
//     i.e. the guarded route surface was enumerated to an unauthenticated caller.

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import type { PluginContext } from "../src/types.js";
import { startServer, type TestServer } from "./helpers/raw-http.js";

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

/**
 * Resolve on "open", reject with the handshake failure so a 401 is observable.
 * The Origin is derived from the target so the same-origin check passes and the
 * hook chain (the thing under test) is what decides the outcome.
 */
function connect(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  const origin = `http://${new URL(url).host}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { origin, ...headers } });
    const timer = setTimeout(() => reject(new Error("timed out waiting for handshake")), 5000);
    socket.on("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * One plugin, registered twice at different prefixes in the tests below. Its
 * `onRequest` guard rejects anything without the bearer token, and it owns both
 * an HTTP route and a WebSocket handler.
 */
function chatPlugin(app: PluginContext): void {
  app.addHook("onRequest", (req, reply) => {
    if (req.headers.get("authorization") !== "Bearer secret") {
      return reply.status(401).json({ error: "Unauthorized" });
    }
  });
  app.get("/chat", (_req, reply) => reply.json({ ok: true }));
}

describe("WebSocket upgrade gate honors prefixed (encapsulated) guards", () => {
  it("rejects an unauthenticated handshake for a plugin registered WITHOUT a prefix", async () => {
    const app = createApp();
    await app.register(chatPlugin);
    let opened = 0;
    app.ws("/chat", { open: () => opened++ });
    const server = await startServer(app);
    servers.push(server);

    await expect(connect(server.wsUrl("/chat"))).rejects.toThrow(/401/);
    expect(opened).toBe(0);
  });

  it("rejects an unauthenticated handshake for the SAME plugin registered WITH a prefix", async () => {
    const app = createApp();
    await app.register(chatPlugin, { prefix: "/api" });
    let opened = 0;
    app.ws("/api/chat", { open: () => opened++ });
    const server = await startServer(app);
    servers.push(server);

    await expect(connect(server.wsUrl("/api/chat"))).rejects.toThrow(/401/);
    expect(opened).toBe(0);
  });

  it("still accepts an authenticated handshake under the prefix", async () => {
    const app = createApp();
    await app.register(chatPlugin, { prefix: "/api" });
    let opened = 0;
    app.ws("/api/chat", { open: () => opened++ });
    const server = await startServer(app);
    servers.push(server);

    const socket = await connect(server.wsUrl("/api/chat"), { authorization: "Bearer secret" });
    expect(opened).toBe(1);
    socket.close();
  });

  it("does not apply a prefixed guard to an upgrade outside that prefix", async () => {
    const app = createApp();
    await app.register(chatPlugin, { prefix: "/api" });
    let opened = 0;
    app.ws("/public/feed", { open: () => opened++ });
    const server = await startServer(app);
    servers.push(server);

    const socket = await connect(server.wsUrl("/public/feed"));
    expect(opened).toBe(1);
    socket.close();
  });
});

describe("405 Allow header does not enumerate routes behind an encapsulated guard", () => {
  /** An admin plugin whose guard 401s, mounted under `/admin`. */
  function adminPlugin(app: PluginContext): void {
    app.addHook("onRequest", (req, reply) => {
      if (req.headers.get("authorization") !== "Bearer secret") {
        return reply.status(401).json({ error: "Unauthorized" });
      }
    });
    app.get("/users/:id", (_req, reply) => reply.json({ id: 1 }));
    app.put("/users/:id", (_req, reply) => reply.json({ updated: true }));
    app.delete("/users/:id", (_req, reply) => reply.json({ deleted: true }));
  }

  it("answers 401, not 405 + Allow, for an unauthenticated method mismatch", async () => {
    const app = createApp();
    await app.register(adminPlugin, { prefix: "/admin" });
    await app.ready();

    const guarded = await app.inject({ method: "GET", url: "/admin/users/1" });
    expect(guarded.status).toBe(401);

    const mismatch = await app.inject({ method: "POST", url: "/admin/users/1" });
    expect(mismatch.status).toBe(401);
    expect(mismatch.headers.get("allow")).toBeNull();
  });

  it("still emits Allow on a 405 once the guard is satisfied", async () => {
    const app = createApp();
    await app.register(adminPlugin, { prefix: "/admin" });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/admin/users/1",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, PUT, DELETE");
  });

  it("still emits Allow on a 405 for an unguarded route", async () => {
    const app = createApp();
    app.get("/public", (_req, reply) => reply.json({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/public" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });
});
