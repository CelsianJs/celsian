// @celsian/adapter-bun — request/response translation and WebSocket bridging
//
// This package previously shipped with zero tests, which is why nobody noticed
// that createBunServeOptions() never set the `websocket` key — making the
// documented "native WebSocket support" impossible: Bun's server.upgrade()
// cannot succeed without it.

import { createApp } from "@celsian/core";
import { describe, expect, it, vi } from "vitest";
import {
  type BunServer,
  type BunWebSocket,
  type BunWSData,
  createBunHandler,
  createBunServeOptions,
  createBunWebSocketHandler,
} from "../src/index.js";

/** Minimal stand-in for Bun's `Server`. Records what the adapter asked it to do. */
function fakeServer(options: { upgradeSucceeds?: boolean; ip?: string } = {}): BunServer & {
  upgrades: Array<{ request: Request; data: BunWSData }>;
} {
  const upgrades: Array<{ request: Request; data: BunWSData }> = [];
  return {
    upgrades,
    upgrade(request, opts) {
      upgrades.push({ request, data: opts?.data as BunWSData });
      return options.upgradeSucceeds !== false;
    },
    requestIP: () => ({ address: options.ip ?? "1.2.3.4" }),
  };
}

/** Minimal stand-in for Bun's `ServerWebSocket`. */
function fakeWS(data: BunWSData): BunWebSocket & { sent: Array<string | ArrayBuffer>; closed: unknown[] } {
  const sent: Array<string | ArrayBuffer> = [];
  const closed: unknown[] = [];
  return {
    data,
    sent,
    closed,
    send(payload) {
      sent.push(payload);
    },
    close(code, reason) {
      closed.push({ code, reason });
    },
  };
}

describe("createBunHandler — HTTP", () => {
  it("translates a request and returns the app's response", async () => {
    const app = createApp();
    app.get("/hello", () => ({ message: "world" }));
    await app.ready();

    const handler = createBunHandler(app);
    const res = await handler(new Request("http://localhost/hello"), fakeServer());

    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ message: "world" });
  });

  it("passes through method, query, and JSON body", async () => {
    const app = createApp();
    app.post("/echo", (req) => ({
      body: req.parsedBody,
      q: req.query.q,
      method: req.method,
    }));
    await app.ready();

    const handler = createBunHandler(app);
    const res = await handler(
      new Request("http://localhost/echo?q=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hi: true }),
      }),
      fakeServer(),
    );

    expect(await res?.json()).toEqual({ body: { hi: true }, q: "1", method: "POST" });
  });

  it("preserves multiple Set-Cookie headers as separate values", async () => {
    const app = createApp();
    app.get("/login", (_req, reply) => {
      reply.cookie("a", "1", { path: "/" });
      reply.cookie("b", "2", { path: "/" });
      return reply.json({ ok: true });
    });
    await app.ready();

    const handler = createBunHandler(app);
    const res = await handler(new Request("http://localhost/login"), fakeServer());
    const cookies = res?.headers.getSetCookie() ?? [];

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^a=1/);
    expect(cookies[1]).toMatch(/^b=2/);
  });

  it("preserves arbitrary response headers and status", async () => {
    const app = createApp();
    app.get("/teapot", (_req, reply) => reply.status(418).header("x-brew", "tea").json({ ok: false }));
    await app.ready();

    const res = await createBunHandler(app)(new Request("http://localhost/teapot"), fakeServer());
    expect(res?.status).toBe(418);
    expect(res?.headers.get("x-brew")).toBe("tea");
  });

  it("streams a streaming body through unchanged", async () => {
    const app = createApp();
    app.get("/stream", () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk-1;"));
          controller.enqueue(new TextEncoder().encode("chunk-2"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/plain" } });
    });
    await app.ready();

    const res = await createBunHandler(app)(new Request("http://localhost/stream"), fakeServer());
    expect(await res?.text()).toBe("chunk-1;chunk-2");
  });

  it("returns a 500 JSON response when app.handle throws", async () => {
    const app = createApp();
    await app.ready();
    vi.spyOn(app, "handle").mockRejectedValueOnce(new Error("kaboom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await createBunHandler(app)(new Request("http://localhost/x"), fakeServer());

    expect(res?.status).toBe(500);
    expect(await res?.json()).toEqual({ error: "Internal Server Error", statusCode: 500 });
    spy.mockRestore();
  });
});

describe("createBunServeOptions", () => {
  it("sets the websocket handler when the app has WS routes", async () => {
    const app = createApp();
    app.ws("/live", {});
    await app.ready();

    const options = createBunServeOptions(app, { port: 1234 });

    // The original bug: this key was never set, so server.upgrade() could never
    // succeed and the documented Bun WebSocket support did not work at all.
    expect(options.websocket).toBeDefined();
    expect(typeof options.websocket?.open).toBe("function");
    expect(typeof options.websocket?.message).toBe("function");
    expect(typeof options.websocket?.close).toBe("function");
    expect(typeof options.websocket?.drain).toBe("function");
    expect(options.port).toBe(1234);
  });

  it("omits the websocket handler when the app has no WS routes", async () => {
    const app = createApp();
    app.get("/", () => "ok");
    await app.ready();

    expect(createBunServeOptions(app).websocket).toBeUndefined();
  });

  it("defaults hostname to 0.0.0.0 and honours the PORT env var", async () => {
    const app = createApp();
    await app.ready();

    const previous = process.env.PORT;
    process.env.PORT = "4321";
    try {
      const options = createBunServeOptions(app);
      expect(options.hostname).toBe("0.0.0.0");
      expect(options.port).toBe(4321);
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });
});

describe("createBunHandler — WebSocket upgrade gate", () => {
  function upgradeRequest(origin: string | null, host = "victim.app", path = "/live"): Request {
    const headers = new Headers({ host, upgrade: "websocket", connection: "Upgrade" });
    if (origin) headers.set("origin", origin);
    return new Request(`http://${host}${path}`, { headers });
  }

  it("upgrades a same-origin handshake and returns undefined so Bun owns the socket", async () => {
    const app = createApp();
    app.ws("/live", {});
    await app.ready();

    const server = fakeServer();
    const res = await createBunHandler(app)(upgradeRequest("http://victim.app"), server);

    expect(res).toBeUndefined();
    expect(server.upgrades).toHaveLength(1);
    expect(server.upgrades[0].data.pathname).toBe("/live");
    expect(server.upgrades[0].data.ip).toBe("1.2.3.4");
  });

  it("rejects a cross-origin handshake with 403 and never calls upgrade", async () => {
    const app = createApp();
    app.ws("/live", {});
    await app.ready();

    const server = fakeServer();
    const res = await createBunHandler(app)(upgradeRequest("https://evil.com"), server);

    expect(res?.status).toBe(403);
    expect(server.upgrades).toHaveLength(0);
  });

  it("rejects a handshake with no Origin header by default", async () => {
    const app = createApp();
    app.ws("/live", {});
    await app.ready();

    const server = fakeServer();
    expect((await createBunHandler(app)(upgradeRequest(null), server))?.status).toBe(403);
    expect(server.upgrades).toHaveLength(0);
  });

  it("honours an allowedOrigins list", async () => {
    const app = createApp();
    app.ws("/live", {});
    await app.ready();

    const handler = createBunHandler(app, { allowedOrigins: ["https://app.example.com"] });
    expect(await handler(upgradeRequest("https://app.example.com"), fakeServer())).toBeUndefined();
    expect((await handler(upgradeRequest("https://other.com"), fakeServer()))?.status).toBe(403);
  });

  it("runs root onRequest hooks on the handshake", async () => {
    const app = createApp();
    app.addHook("onRequest", (req) => {
      if (!req.headers.get("authorization")) return new Response("Unauthorized", { status: 401 });
    });
    app.ws("/live", {});
    await app.ready();

    const server = fakeServer();
    const res = await createBunHandler(app)(upgradeRequest("http://victim.app"), server);

    expect(res?.status).toBe(401);
    expect(server.upgrades).toHaveLength(0);
  });

  it("passes a non-upgrade request on a WS path to the app", async () => {
    const app = createApp();
    app.ws("/live", {});
    app.get("/live", () => ({ http: true }));
    await app.ready();

    const res = await createBunHandler(app)(new Request("http://victim.app/live"), fakeServer());
    expect(await res?.json()).toEqual({ http: true });
  });

  it("returns 400 when Bun refuses the upgrade", async () => {
    const app = createApp();
    app.ws("/live", {});
    await app.ready();

    const res = await createBunHandler(app)(
      upgradeRequest("http://victim.app"),
      fakeServer({ upgradeSucceeds: false }),
    );
    expect(res?.status).toBe(400);
  });
});

describe("createBunWebSocketHandler — registry bridge", () => {
  const data = (ip = "1.2.3.4"): BunWSData => ({
    pathname: "/live",
    ip,
    request: new Request("http://victim.app/live?room=1"),
  });

  it("drives open, message, and close through the app's WS handler", async () => {
    const app = createApp();
    const events: string[] = [];
    app.ws("/live", {
      open: (ws, req) => {
        events.push(`open:${new URL(req.url).searchParams.get("room")}`);
        ws.send("welcome");
      },
      message: (ws, msg) => {
        events.push(`message:${String(msg)}`);
        ws.send(`echo:${String(msg)}`);
      },
      close: (_ws, code, reason) => events.push(`close:${code}:${reason}`),
    });
    await app.ready();

    const bridge = createBunWebSocketHandler(app);
    const ws = fakeWS(data());

    bridge.open(ws);
    expect(app.wsRegistry.getConnectionCount("/live")).toBe(1);

    bridge.message(ws, "ping");
    bridge.close(ws, 1000, "bye");

    expect(events).toEqual(["open:1", "message:ping", "close:1000:bye"]);
    expect(ws.sent).toEqual(["welcome", "echo:ping"]);
    expect(app.wsRegistry.getConnectionCount("/live")).toBe(0);
  });

  it("converts a binary Uint8Array frame to an ArrayBuffer", async () => {
    const app = createApp();
    let received: unknown;
    app.ws("/live", {
      message: (_ws, msg) => {
        received = msg;
      },
    });
    await app.ready();

    const bridge = createBunWebSocketHandler(app);
    const ws = fakeWS(data());
    bridge.open(ws);
    bridge.message(ws, new Uint8Array([1, 2, 3]));

    expect(received).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(received as ArrayBuffer))).toEqual([1, 2, 3]);
  });

  it("reaches the app's broadcast helper through the bridged connection", async () => {
    const app = createApp();
    app.ws("/live", {});
    await app.ready();

    const bridge = createBunWebSocketHandler(app);
    const a = fakeWS(data("1.1.1.1"));
    const b = fakeWS(data("2.2.2.2"));
    bridge.open(a);
    bridge.open(b);

    app.wsBroadcast("/live", "hello");
    expect(a.sent).toEqual(["hello"]);
    expect(b.sent).toEqual(["hello"]);
  });

  it("closes a connection past the per-IP cap", async () => {
    const app = createApp();
    let opened = 0;
    app.ws("/live", { open: () => opened++ });
    await app.ready();

    const bridge = createBunWebSocketHandler(app, { maxConnectionsPerIP: 1 });
    bridge.open(fakeWS(data("9.9.9.9")));
    const second = fakeWS(data("9.9.9.9"));
    bridge.open(second);

    expect(opened).toBe(1);
    expect(second.closed).toEqual([{ code: 1013, reason: "Too many connections" }]);
  });

  it("exposes maxPayloadLength with a 1 MiB default", async () => {
    const app = createApp();
    app.ws("/live", {});
    await app.ready();

    expect(createBunWebSocketHandler(app).maxPayloadLength).toBe(1024 * 1024);
    expect(createBunWebSocketHandler(app, { maxPayload: 4096 }).maxPayloadLength).toBe(4096);
  });

  it("closes a socket whose path has no handler", async () => {
    const app = createApp();
    app.ws("/live", {});
    await app.ready();

    const bridge = createBunWebSocketHandler(app);
    const ws = fakeWS({ pathname: "/gone", ip: "1.2.3.4", request: new Request("http://victim.app/gone") });
    bridge.open(ws);

    expect(ws.closed).toEqual([{ code: 1011, reason: "No handler" }]);
  });

  it("ignores messages and closes for sockets that never opened", async () => {
    const app = createApp();
    let messages = 0;
    app.ws("/live", { message: () => messages++ });
    await app.ready();

    const bridge = createBunWebSocketHandler(app);
    const ws = fakeWS(data());
    expect(() => bridge.message(ws, "orphan")).not.toThrow();
    expect(() => bridge.close(ws, 1000, "")).not.toThrow();
    expect(messages).toBe(0);
  });
});
