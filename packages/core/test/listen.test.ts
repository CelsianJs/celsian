import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ServeResult } from "../src/serve.js";

describe("app.listen()", () => {
  let handle: ServeResult | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  it("should start the server and accept requests", async () => {
    const app = createApp();
    app.get("/ping", (_req, reply) => reply.json({ pong: true }));

    const port = 49_321;
    const ready = new Promise<{ port: number; host: string }>((resolve) => {
      app.listen(port, (info) => resolve(info)).then((h) => {
        handle = h;
      });
    });

    const info = await ready;
    expect(info.port).toBe(port);

    // Make a real HTTP request to verify the server works
    const response = await fetch(`http://localhost:${port}/ping`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ pong: true });
  });

  it("should accept ServeOptions object as first argument", async () => {
    const app = createApp();
    app.get("/ok", (_req, reply) => reply.json({ ok: true }));

    const port = 49_322;
    const ready = new Promise<void>((resolve) => {
      app.listen({ port, onReady: () => resolve() }).then((h) => {
        handle = h;
      });
    });

    await ready;
    const response = await fetch(`http://localhost:${port}/ok`);
    expect(response.status).toBe(200);
  });

  it("should default to port 3000 when no port given", async () => {
    const app = createApp();
    app.get("/default", (_req, reply) => reply.json({ ok: true }));

    // Port 3000 is commonly occupied in dev/CI, so we test the default
    // wiring by observing that listen() attempts port 3000. If it binds
    // successfully, verify via HTTP. If EADDRINUSE fires, the port number
    // in the error itself proves the default was applied correctly.
    interface ListenError extends Error { code?: string; port?: number }

    const result = await new Promise<{ port: number } | { error: ListenError }>((resolve) => {
      // Capture EADDRINUSE before it becomes an uncaught exception
      const onError = (err: ListenError) => {
        if (err.code === "EADDRINUSE") {
          process.removeListener("uncaughtException", onError);
          resolve({ error: err });
        }
      };
      process.on("uncaughtException", onError);

      app.listen(undefined, (info) => {
        process.removeListener("uncaughtException", onError);
        resolve({ port: info.port });
      }).then((h) => {
        handle = h;
      });
    });

    if ("error" in result) {
      // EADDRINUSE on port 3000 proves the default was applied
      expect(result.error.port).toBe(3000);
    } else {
      expect(result.port).toBe(3000);
      const response = await fetch("http://localhost:3000/default");
      expect(response.status).toBe(200);
    }
  });
});
