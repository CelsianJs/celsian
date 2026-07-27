// @celsian/core, serve() WebSocket upgrade, end to end over a real socket
//
// Regression suite for H-5. Before the fix, serve()'s upgrade handler resolved a
// handler and called wss.handleUpgrade() with no Origin check and without running
// any onRequest hook, so a page on evil.com could open an authenticated socket
// with the victim's cookies attached (cross-site WebSocket hijacking).

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import { type ServeOptions, type ServeResult, serve } from "../src/serve.js";

const servers: ServeResult[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function start(
  app: ReturnType<typeof createApp>,
  options: Partial<ServeOptions> = {},
): Promise<{ port: number; url: (path: string) => string }> {
  let boundPort = 0;
  const result = await serve(app, {
    port: 0,
    host: "127.0.0.1",
    // Vitest owns the process; a test-scoped server must not install exit-on-fatal handlers.
    handleFatalErrors: false,
    onReady: ({ port }) => {
      boundPort = port;
    },
    ...options,
  });
  servers.push(result);
  return { port: boundPort, url: (path) => `ws://127.0.0.1:${boundPort}${path}` };
}

/** Resolve "open" or reject with the handshake failure, so 403s are observable. */
function connect(url: string, options?: { origin?: string }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
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

describe("serve() WebSocket upgrade, Origin gate", () => {
  it("rejects a cross-origin handshake with 403", async () => {
    const app = createApp();
    let opened = 0;
    app.ws("/chat", { open: () => opened++ });
    const { url } = await start(app);

    await expect(connect(url("/chat"), { origin: "http://evil.com" })).rejects.toThrow(/403/);
    expect(opened).toBe(0);
  });

  it("accepts a same-origin handshake and delivers messages", async () => {
    const app = createApp();
    const received: string[] = [];
    app.ws("/chat", {
      message: (ws, data) => {
        received.push(String(data));
        ws.send("pong");
      },
    });
    const { port, url } = await start(app);

    const socket = await connect(url("/chat"), { origin: `http://127.0.0.1:${port}` });
    const reply = await new Promise<string>((resolve) => {
      socket.on("message", (data) => resolve(data.toString()));
      socket.send("ping");
    });

    expect(received).toEqual(["ping"]);
    expect(reply).toBe("pong");
    socket.close();
  });

  it("rejects a handshake with no Origin header by default", async () => {
    const app = createApp();
    app.ws("/chat", {});
    const { url } = await start(app);

    // The `ws` client omits Origin unless asked, the non-browser client case.
    await expect(connect(url("/chat"))).rejects.toThrow(/403/);
  });

  it("accepts a missing Origin when allowMissingOrigin is set", async () => {
    const app = createApp();
    app.ws("/chat", {});
    const { url } = await start(app, { allowMissingOrigin: true });

    const socket = await connect(url("/chat"));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("accepts an allow-listed cross-origin handshake", async () => {
    const app = createApp();
    app.ws("/chat", {});
    const { url } = await start(app, { allowedOrigins: ["https://app.example.com"] });

    const socket = await connect(url("/chat"), { origin: "https://app.example.com" });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();

    await expect(connect(url("/chat"), { origin: "https://evil.com" })).rejects.toThrow(/403/);
  });
});

describe("serve() WebSocket upgrade, hooks", () => {
  it("runs root onRequest hooks so an auth guard can reject the handshake", async () => {
    const app = createApp();
    app.addHook("onRequest", (req) => {
      if (req.headers.get("authorization") !== "Bearer good") {
        return new Response("Unauthorized", { status: 401 });
      }
    });
    let opened = 0;
    app.ws("/chat", { open: () => opened++ });
    const { port, url } = await start(app);

    await expect(connect(url("/chat"), { origin: `http://127.0.0.1:${port}` })).rejects.toThrow(/401/);
    expect(opened).toBe(0);
  });

  it("lets an authorized handshake through the same guard", async () => {
    const app = createApp();
    app.addHook("onRequest", (req) => {
      if (req.headers.get("authorization") !== "Bearer good") {
        return new Response("Unauthorized", { status: 401 });
      }
    });
    app.ws("/chat", {});
    const { port } = await start(app);

    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/chat`, {
        origin: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer good" },
      });
      s.on("open", () => resolve(s));
      s.on("error", reject);
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("destroys the socket for a path with no WS handler", async () => {
    const app = createApp();
    app.ws("/chat", {});
    const { port, url } = await start(app);

    await expect(connect(url("/nope"), { origin: `http://127.0.0.1:${port}` })).rejects.toThrow();
  });
});

describe("serve() WebSocket upgrade, connection cap", () => {
  it("rejects connections beyond maxConnectionsPerIP", async () => {
    const app = createApp();
    app.ws("/chat", {});
    const { port, url } = await start(app, { maxConnectionsPerIP: 1 });
    const origin = `http://127.0.0.1:${port}`;

    const first = await connect(url("/chat"), { origin });
    await expect(connect(url("/chat"), { origin })).rejects.toThrow(/429/);

    first.close();
  });
});

// The upgrade GATE resolves the client's real host itself, so this was never an
// auth bypass. But the CelsianRequest handed to `handler.open` was still built
// from the URL composed out of the address the server BOUND to, which is
// `0.0.0.0` under NODE_ENV=production. A handler that routes on host, which is
// how a multi-tenant app dispatches, therefore saw `http://0.0.0.0:PORT/chat`
// for every tenant. Measured before the fix:
//   {"urlSeenByHandler":"http://0.0.0.0:5701/chat"}
describe("serve() WebSocket upgrade, host seen by the handler", () => {
  it("reports the host the client addressed, not the bind address", async () => {
    const app = createApp();
    let seen = "";
    app.ws("/chat", {
      open: (_conn, req) => {
        seen = req?.url ?? "";
      },
    });
    // Bind the wildcard, which is what production does and what made the bug
    // invisible on a loopback-bound dev server.
    const { url, port } = await start(app, { host: "0.0.0.0" });

    const socket = await connect(url("/chat"), {
      origin: "http://tenant-a.example.com",
      headers: { host: "tenant-a.example.com" },
    } as never);
    // `open` fires before the client's "open" resolves in some orderings, so
    // give the handler a turn rather than asserting on a race.
    await new Promise((r) => setTimeout(r, 50));
    socket.close();

    expect(seen).toBe("http://tenant-a.example.com/chat");
    expect(seen).not.toContain("0.0.0.0");
    expect(seen).not.toContain(String(port));
  });
});
