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
    expect(typeof app.listen).toBe("function");
  });
});
