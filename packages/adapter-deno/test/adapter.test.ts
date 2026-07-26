// @celsian/adapter-deno — request/response translation and serveDeno() wiring
//
// This package previously shipped to npm with zero tests and 0% executed lines.

import { CelsianError, createApp } from "@celsian/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDenoHandler, type DenoFetchHandler, type DenoServeOptions, serveDeno } from "../src/index.js";

type DenoGlobal = { serve: (opts: DenoServeOptions, handler: DenoFetchHandler) => void } | undefined;

function withFakeDeno<T>(fn: (calls: Array<{ opts: DenoServeOptions; handler: DenoFetchHandler }>) => T): T {
  const calls: Array<{ opts: DenoServeOptions; handler: DenoFetchHandler }> = [];
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.Deno as DenoGlobal;
  globals.Deno = {
    serve: (opts: DenoServeOptions, handler: DenoFetchHandler) => {
      calls.push({ opts, handler });
    },
  };
  try {
    return fn(calls);
  } finally {
    if (previous === undefined) delete globals.Deno;
    else globals.Deno = previous;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDenoHandler", () => {
  it("returns the app's response for a matched route", async () => {
    const app = createApp();
    app.get("/hello", () => ({ message: "world" }));
    await app.ready();

    const res = await createDenoHandler(app)(new Request("http://localhost/hello"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "world" });
  });

  it("passes through method, route params, query, and JSON body", async () => {
    const app = createApp();
    app.post("/items/:id", (req) => ({
      id: req.params.id,
      q: req.query.q,
      body: req.parsedBody,
      method: req.method,
    }));
    await app.ready();

    const res = await createDenoHandler(app)(
      new Request("http://localhost/items/42?q=x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "thing" }),
      }),
    );

    expect(await res.json()).toEqual({ id: "42", q: "x", body: { name: "thing" }, method: "POST" });
  });

  it("preserves status and arbitrary headers", async () => {
    const app = createApp();
    app.get("/teapot", (_req, reply) => reply.status(418).header("x-brew", "tea").json({ ok: false }));
    await app.ready();

    const res = await createDenoHandler(app)(new Request("http://localhost/teapot"));
    expect(res.status).toBe(418);
    expect(res.headers.get("x-brew")).toBe("tea");
  });

  it("preserves multiple Set-Cookie headers as separate values", async () => {
    const app = createApp();
    app.get("/login", (_req, reply) => {
      reply.cookie("session", "abc", { path: "/", httpOnly: true });
      reply.cookie("theme", "dark", { path: "/" });
      return reply.json({ ok: true });
    });
    await app.ready();

    const res = await createDenoHandler(app)(new Request("http://localhost/login"));
    const cookies = res.headers.getSetCookie();

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^session=abc/);
    expect(cookies[0]).toMatch(/HttpOnly/i);
    expect(cookies[1]).toMatch(/^theme=dark/);
  });

  it("passes a streaming body through unchanged", async () => {
    const app = createApp();
    app.get("/stream", () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("a"));
            controller.enqueue(encoder.encode("b"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    });
    await app.ready();

    const res = await createDenoHandler(app)(new Request("http://localhost/stream"));
    expect(await res.text()).toBe("ab");
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  it("returns the app's 404 for an unknown route", async () => {
    const app = createApp();
    await app.ready();

    const res = await createDenoHandler(app)(new Request("http://localhost/nope"));
    expect(res.status).toBe(404);
  });

  it("returns a 500 JSON response when app.handle throws", async () => {
    const app = createApp();
    await app.ready();
    vi.spyOn(app, "handle").mockRejectedValueOnce(new Error("kaboom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await createDenoHandler(app)(new Request("http://localhost/x"));

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ error: "Internal Server Error", statusCode: 500 });
  });
});

describe("serveDeno", () => {
  it("calls Deno.serve with the resolved port and hostname", async () => {
    const app = createApp();
    await app.ready();

    withFakeDeno((calls) => {
      serveDeno(app, { port: 8080, hostname: "127.0.0.1" });
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.port).toBe(8080);
      expect(calls[0].opts.hostname).toBe("127.0.0.1");
    });
  });

  it("defaults to 0.0.0.0 and honours the PORT env var", async () => {
    const app = createApp();
    await app.ready();

    const previous = process.env.PORT;
    process.env.PORT = "9001";
    try {
      withFakeDeno((calls) => {
        serveDeno(app);
        expect(calls[0].opts.port).toBe(9001);
        expect(calls[0].opts.hostname).toBe("0.0.0.0");
      });
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });

  it("forwards the abort signal and a custom onListen", async () => {
    const app = createApp();
    await app.ready();
    const controller = new AbortController();
    const onListen = vi.fn();

    withFakeDeno((calls) => {
      serveDeno(app, { signal: controller.signal, onListen });
      expect(calls[0].opts.signal).toBe(controller.signal);
      calls[0].opts.onListen?.({ port: 3000, hostname: "0.0.0.0" });
      expect(onListen).toHaveBeenCalledWith({ port: 3000, hostname: "0.0.0.0" });
    });
  });

  it("hands Deno.serve a working request handler", async () => {
    const app = createApp();
    app.get("/ping", () => ({ pong: true }));
    await app.ready();

    const handler = withFakeDeno((calls) => {
      serveDeno(app);
      return calls[0].handler;
    });

    const res = await handler(new Request("http://localhost/ping"));
    expect(await res.json()).toEqual({ pong: true });
  });

  it("throws a CelsianError (not a bare Error) outside the Deno runtime", async () => {
    const app = createApp();
    await app.ready();

    const globals = globalThis as Record<string, unknown>;
    const previous = globals.Deno;
    delete globals.Deno;
    try {
      expect(() => serveDeno(app)).toThrow(CelsianError);
      expect(() => serveDeno(app)).toThrow(/requires the Deno runtime/);
    } finally {
      if (previous !== undefined) globals.Deno = previous;
    }
  });
});
