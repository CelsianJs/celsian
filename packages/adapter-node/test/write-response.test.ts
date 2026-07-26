// @celsian/adapter-node — writeWebResponse header fidelity
//
// Regression: writeWebResponse() iterated response.headers.entries(), which
// collapses repeated Set-Cookie into a single comma-joined value. Any cookie
// with a comma in it (an `Expires` date always has one) was corrupted, and two
// cookies arrived as one malformed header.

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../core/src/app.js";
import { nodeToWebRequest, writeWebResponse } from "../src/index.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function serveOnce(app: ReturnType<typeof createApp>): Promise<string> {
  await app.ready();
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const response = await app.handle(nodeToWebRequest(req, url));
    await writeWebResponse(res, response);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe("writeWebResponse", () => {
  it("writes each Set-Cookie as its own header line", async () => {
    const app = createApp();
    app.get("/login", (_req, reply) => {
      reply.cookie("session", "abc", { path: "/", httpOnly: true });
      reply.cookie("theme", "dark", { path: "/" });
      return reply.json({ ok: true });
    });

    const base = await serveOnce(app);
    const res = await fetch(`${base}/login`);
    const cookies = res.headers.getSetCookie();

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^session=abc/);
    expect(cookies[1]).toMatch(/^theme=dark/);
  });

  it("keeps a cookie containing a comma (Expires) intact", async () => {
    const app = createApp();
    app.get("/expiring", (_req, reply) => {
      reply.cookie("a", "1", { path: "/", expires: new Date("2030-01-01T00:00:00Z") });
      reply.cookie("b", "2", { path: "/", expires: new Date("2031-01-01T00:00:00Z") });
      return reply.json({ ok: true });
    });

    const base = await serveOnce(app);
    const res = await fetch(`${base}/expiring`);
    const cookies = res.headers.getSetCookie();

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^a=1;/);
    expect(cookies[0]).toMatch(/Expires=.*2030/);
    expect(cookies[1]).toMatch(/^b=2;/);
    expect(cookies[1]).toMatch(/Expires=.*2031/);
  });

  it("preserves status, ordinary headers, and the body", async () => {
    const app = createApp();
    app.get("/teapot", (_req, reply) => reply.status(418).header("x-brew", "tea").json({ ok: false }));

    const base = await serveOnce(app);
    const res = await fetch(`${base}/teapot`);

    expect(res.status).toBe(418);
    expect(res.headers.get("x-brew")).toBe("tea");
    expect(await res.json()).toEqual({ ok: false });
  });

  it("streams a chunked body through to the client", async () => {
    const app = createApp();
    app.get("/stream", () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("chunk-1;"));
            controller.enqueue(encoder.encode("chunk-2"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    });

    const base = await serveOnce(app);
    const res = await fetch(`${base}/stream`);
    expect(await res.text()).toBe("chunk-1;chunk-2");
  });
});
