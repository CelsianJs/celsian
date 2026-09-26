// @celsian/core, serve() shutdown with long-lived sockets

import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import { type ServeOptions, type ServeResult, serve } from "../src/serve.js";
import { createSSEStream } from "../src/sse.js";

const servers: ServeResult[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function start(
  app: ReturnType<typeof createApp>,
  shutdownTimeout = 150,
  options: Partial<ServeOptions> = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  let boundPort = 0;
  const result = await serve(app, {
    port: 0,
    host: "127.0.0.1",
    allowMissingOrigin: true,
    handleFatalErrors: false,
    shutdownTimeout,
    onReady: ({ port }) => {
      boundPort = port;
    },
    ...options,
  });
  servers.push(result);
  return {
    port: boundPort,
    close: result.close,
  };
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timed]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function socketClosed(socket: net.Socket | WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
}

function createRawWebSocketHandshake(port: number, path = "/chat"): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    let buffer = "";
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(1000, () => fail(new Error("raw WebSocket handshake timed out")));
    socket.once("error", fail);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (!buffer.includes("\r\n\r\n")) return;
      socket.setTimeout(0);
      socket.off("error", fail);
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      expect(buffer).toContain("HTTP/1.1 101");
      expect(buffer.toLowerCase()).toContain(`sec-websocket-accept: ${accept.toLowerCase()}`);
      resolve(socket);
    });
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          `Origin: http://127.0.0.1:${port}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
}

describe("serve() graceful shutdown, long-lived connections", () => {
  it("closes an open SSE response instead of leaving the process pinned", async () => {
    const app = createApp({ logger: false });
    app.get("/events", (req) => {
      const channel = createSSEStream(req, { pingInterval: 0 });
      channel.send({ event: "ready", data: "ok" });
      return channel.response;
    });
    const { port, close } = await start(app);

    const response = await fetch(`http://127.0.0.1:${port}/events`);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected SSE response body");
    await reader.read();

    await timeout(close(), 1000, "server close");
    servers.pop();

    let clientClosed = false;
    try {
      const chunk = await timeout(reader.read(), 1000, "SSE client close");
      clientClosed = chunk.done;
    } catch {
      // Node reports a server-side socket destroy as a stream error, which is
      // still an acceptable shutdown outcome: the client is no longer pinned.
      clientClosed = true;
    }
    expect(clientClosed).toBe(true);
  });

  it("closes compliant WebSockets with code 1001 during shutdown", async () => {
    const app = createApp({ logger: false });
    let closeCode = 0;
    let closeReason = "";
    app.ws("/chat", {
      close(_ws, code, reason) {
        closeCode = code;
        closeReason = reason;
      },
    });
    const { port, close } = await start(app);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat`);

    await timeout(once(socket, "open"), 1000, "WebSocket open");
    const socketClosed = once(socket, "close");

    await timeout(close(), 1000, "server close");
    servers.pop();
    const [clientCode, clientReason] = (await timeout(socketClosed, 1000, "WebSocket close")) as [number, Buffer];

    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(clientCode).toBe(1001);
    expect(clientReason.toString()).toBe("Server shutting down");
    expect(closeCode).toBe(1001);
    expect(closeReason).toBe("Server shutting down");
  });

  it("terminates an uncooperative WebSocket after the graceful timeout", async () => {
    const app = createApp({ logger: false });
    app.ws("/chat", {});
    const { port, close } = await start(app, 100);
    const socket = await timeout(createRawWebSocketHandshake(port), 1000, "raw WebSocket handshake");

    const closed = socketClosed(socket);
    const started = Date.now();
    await timeout(close(), 1000, "server close");
    servers.pop();
    await timeout(closed, 1000, "raw WebSocket close");

    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(socket.destroyed).toBe(true);
  });

  it("lets ordinary in-flight HTTP responses finish inside the grace period", async () => {
    const app = createApp({ logger: false });
    app.get("/slow", async () => {
      await delay(50);
      return { ok: true };
    });
    const { port, close } = await start(app, 500);

    const responsePromise = fetch(`http://127.0.0.1:${port}/slow`);
    await delay(10);
    await timeout(close(), 1000, "server close");
    servers.pop();

    const response = await timeout(responsePromise, 1000, "in-flight response");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("does not let an accepted raw socket with no request pin shutdown", async () => {
    const app = createApp({ logger: false });
    app.get("/", () => ({ ok: true }));
    const { port, close } = await start(app, 100);
    const socket = net.connect(port, "127.0.0.1");
    await timeout(once(socket, "connect"), 1000, "raw socket connect");

    const closed = socketClosed(socket);
    await timeout(close(), 1000, "server close");
    servers.pop();
    await timeout(closed, 1000, "raw socket close");

    expect(socket.destroyed).toBe(true);
  });

  it("does not establish a WebSocket if shutdown starts during async upgrade authorization", async () => {
    const app = createApp({ logger: false });
    let opened = false;
    let releaseUpgrade: (() => void) | undefined;
    const upgradeStarted = new Promise<void>((resolveStarted) => {
      releaseUpgrade = undefined;
      app.ws("/chat", {
        open() {
          opened = true;
        },
      });
      releaseUpgrade = resolveStarted;
    });
    let allowUpgrade!: () => void;
    const holdUpgrade = new Promise<boolean>((resolve) => {
      allowUpgrade = () => resolve(true);
    });
    const { port, close } = await start(app, 100, {
      onUpgrade: async () => {
        releaseUpgrade?.();
        return holdUpgrade;
      },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat`, { origin: `http://127.0.0.1:${port}` });
    const clientClosed = socketClosed(socket);

    await timeout(upgradeStarted, 1000, "upgrade start");
    const closePromise = timeout(close(), 1000, "server close");
    allowUpgrade();
    await closePromise;
    servers.pop();
    await timeout(clientClosed, 1000, "pending upgrade client close");

    expect(opened).toBe(false);
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
  });
});
