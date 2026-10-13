// @celsian/adapter-node, real HTTP stream backpressure and disconnect parity

import { once } from "node:events";
import {
  createServer,
  get,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../core/src/app.js";
import * as core from "../../core/src/serve.js";
import * as adapter from "../src/index.js";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe.each([
  { name: "core", bridge: core },
  { name: "adapter", bridge: adapter },
])("$name stream bridge", ({ bridge }) => {
  it.each(["close", "error", "destroy-error"])(
    "releases the upstream reader on %s under backpressure",
    async (event) => {
      const failure = new Error("socket failed");
      let cancelled = 0;
      let observed: unknown;
      let response: ServerResponse | undefined;
      let body: ReadableStream<Uint8Array> | undefined;
      let settle: (() => void) | undefined;
      const written = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const server = createServer({ highWaterMark: 1 }, async (_req, res) => {
        response = res;
        res.on("error", () => {});
        const write = res.write.bind(res);
        vi.spyOn(res, "write").mockImplementation((chunk: Uint8Array) => {
          const accepted = write(chunk);
          queueMicrotask(() => {
            if (event === "error") res.emit("error", failure);
            res.destroy(event === "destroy-error" ? failure : undefined);
          });
          return accepted;
        });
        let chunks = 0;
        body = new ReadableStream({
          pull(controller) {
            if (chunks++ < 100) controller.enqueue(new Uint8Array(64 * 1024));
            else controller.close();
          },
          cancel() {
            cancelled++;
          },
        });
        try {
          await bridge.writeWebResponse(res, new Response(body));
        } catch (error) {
          observed = error;
        } finally {
          settle?.();
        }
      });
      try {
        const url = await listen(server);
        const client = get(url, (res) => {
          res.on("error", () => {});
          res.resume();
        });
        client.on("error", () => {});
        await written;
        expect(observed).toBe(event === "close" ? undefined : failure);
        expect(cancelled).toBe(1);
        expect(body?.locked).toBe(false);
        expect(response?.listenerCount("drain")).toBe(0);
      } finally {
        await close(server);
      }
    },
  );

  it("waits for drain before writing more chunks to a slow HTTP client", async () => {
    let writesWhileBlocked = 0;
    let backpressureCount = 0;
    let failure: unknown;
    const server = createServer({ highWaterMark: 1024 }, async (_req, res) => {
      let blocked = false;
      const write = res.write.bind(res);
      vi.spyOn(res, "write").mockImplementation((chunk: Uint8Array) => {
        if (blocked) writesWhileBlocked++;
        const accepted = write(chunk);
        if (!accepted) {
          blocked = true;
          backpressureCount++;
        }
        return accepted;
      });
      res.on("drain", () => {
        blocked = false;
      });
      let chunks = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks++ < 100) controller.enqueue(new Uint8Array(64 * 1024));
          else controller.close();
        },
      });
      try {
        await bridge.writeWebResponse(res, new Response(stream));
      } catch (error) {
        failure = error;
        res.destroy();
      }
    });
    try {
      const url = await listen(server);
      const bytes = await new Promise<number>((resolve, reject) => {
        get(url, (res) => {
          res.pause();
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
          });
          res.on("end", () => resolve(total));
          res.on("error", reject);
          setTimeout(() => res.resume(), 25);
        }).on("error", reject);
      });
      expect(failure).toBeUndefined();
      expect(bytes).toBe(100 * 64 * 1024);
      expect(backpressureCount).toBeGreaterThan(0);
      expect(writesWhileBlocked).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("aborts the request and cancels an idle upstream stream when the client disconnects", async () => {
    let signal: AbortSignal | undefined;
    let cancelled = 0;
    let finished = false;
    let body: ReadableStream<Uint8Array> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const server = createServer(async (req, res) => {
      signal = bridge.nodeToWebRequest(req, new URL("http://localhost/")).signal;
      body = new ReadableStream({
        start(value) {
          controller = value;
          value.enqueue(new TextEncoder().encode("ready"));
        },
        cancel() {
          cancelled++;
        },
      });
      try {
        await bridge.writeWebResponse(res, new Response(body));
      } finally {
        finished = true;
      }
    });
    try {
      const url = await listen(server);
      await new Promise<void>((resolve, reject) => {
        get(url, (res) => {
          res.once("data", () => {
            res.destroy();
            resolve();
          });
        }).on("error", reject);
      });
      await expect
        .poll(() => ({ aborted: signal?.aborted, cancelled, finished }), { timeout: 300 })
        .toEqual({ aborted: true, cancelled: 1, finished: true });
      expect(body?.locked).toBe(false);
    } finally {
      if (!cancelled) controller?.close();
      await close(server);
    }
  });

  it("does not abort a fully received POST body or retain socket listeners after the response", async () => {
    let signal: AbortSignal | undefined;
    let incoming: IncomingMessage | undefined;
    let addedListeners: ReturnType<IncomingMessage["socket"]["listeners"]> = [];
    const server = createServer(async (req, res) => {
      incoming = req;
      const listenersBefore = new Set(req.socket.listeners("close"));
      const web = bridge.nodeToWebRequest(req, new URL("http://localhost/"));
      addedListeners = req.socket.listeners("close").filter((listener) => !listenersBefore.has(listener));
      signal = web.signal;
      const text = await web.text();
      await delay(10);
      await bridge.writeWebResponse(res, Response.json({ text, aborted: signal.aborted }));
    });
    try {
      const url = await listen(server);
      const response = await fetch(url, { method: "POST", body: "complete" });
      expect(await response.json()).toEqual({ text: "complete", aborted: false });
      await delay(10);
      expect(incoming?.socket.listeners("close").filter((listener) => addedListeners.includes(listener))).toEqual([]);
      expect(signal?.aborted).toBe(false);
    } finally {
      await close(server);
    }
    expect(signal?.aborted).toBe(false);
  });
});

it.each([0, 30_000])(
  "core serve's fast request conversion propagates disconnect with timeout %i",
  async (requestTimeout) => {
    const app = createApp({ requestTimeout });
    let signal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.get("/pending", async (req) => {
      signal = req.signal;
      started?.();
      await pending;
      return new Response("done");
    });
    let port = 0;
    const running = await core.serve(app, {
      port: 0,
      host: "127.0.0.1",
      handleFatalErrors: false,
      shutdownTimeout: 100,
      onReady: (info) => {
        port = info.port;
      },
    });
    const client = httpRequest(`http://127.0.0.1:${port}/pending`);
    client.on("error", () => {});
    client.end();
    try {
      await entered;
      client.destroy();
      await expect.poll(() => signal?.aborted, { timeout: 300 }).toBe(true);
    } finally {
      release?.();
      client.destroy();
      await running.close();
    }
  },
);
