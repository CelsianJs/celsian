// @celsian/core, reply headers and a Response the handler built itself
//
// A header set with `reply.header()` belongs on the response whether the
// handler finishes with a reply helper or returns its own `Response`. When both
// set the same header, the Response's own value wins: an onSend hook reads
// `reply.headers` and cannot see the Response, so it must not clobber a value it
// never saw. It may still override a value it was shown. Set-Cookie and Vary
// are lists, so values from both sides are kept.

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { cors } from "../src/plugins/cors.js";
import { type RawResponse, startServer, type TestServer } from "./helpers/raw-http.js";

/** The Set-Cookie values a raw response carried, one entry per header line. */
function wireCookies(res: RawResponse): string[] {
  const value = res.headers["set-cookie"];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The "no-store unless the reply already has one" policy hook. */
function defaultNoStore(app: ReturnType<typeof createApp>) {
  app.addHook("onSend", (_req, reply) => {
    if (reply.headers["cache-control"] === undefined) reply.header("cache-control", "no-store");
  });
}

describe("reply headers merged into a returned Response", () => {
  it("keeps a header set with reply.header() before returning a Response", async () => {
    const app = createApp();
    app.get("/limited", (_req, reply) => {
      reply.header("retry-after", "30");
      return new Response("slow down", { status: 429 });
    });

    const res = await app.inject({ url: "/limited" });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.text()).toBe("slow down");
  });

  it("keeps it when onSend hooks are registered too", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, reply) => {
      reply.header("x-served-by", "celsian");
    });
    app.get("/limited", (_req, reply) => {
      reply.header("retry-after", "30");
      return new Response("slow down", { status: 429 });
    });

    const res = await app.inject({ url: "/limited" });

    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("x-served-by")).toBe("celsian");
  });

  it("keeps a header set by an onRequest hook on a handler's Response", async () => {
    const app = createApp();
    app.addHook("onRequest", (_req, reply) => {
      reply.header("x-request-id", "req-1");
    });
    app.get("/raw", () => new Response("raw"));

    const res = await app.inject({ url: "/raw" });

    expect(res.headers.get("x-request-id")).toBe("req-1");
  });

  it("lets the Response's own value win over a reply header set before it", async () => {
    const app = createApp();
    app.get("/typed", (_req, reply) => {
      reply.header("content-type", "text/plain");
      return new Response("<p>hi</p>", { headers: { "content-type": "text/html" } });
    });

    const res = await app.inject({ url: "/typed" });

    expect(res.headers.get("content-type")).toBe("text/html");
  });

  it("does not let an onSend hook overwrite a header the returned Response set", async () => {
    const app = createApp();
    defaultNoStore(app);
    app.get("/.well-known/openid-configuration", () =>
      Response.json({ issuer: "https://id.example.com" }, { headers: { "cache-control": "public, max-age=300" } }),
    );

    const res = await app.inject({ url: "/.well-known/openid-configuration" });

    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("still lets the onSend hook fill in a header the Response did not set", async () => {
    const app = createApp();
    defaultNoStore(app);
    app.get("/raw", () => new Response("raw"));

    const res = await app.inject({ url: "/raw" });

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("still lets an onSend hook override a header it could see on the reply", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, reply) => {
      if (reply.headers["cache-control"] === "public") reply.header("cache-control", "private");
    });
    app.get("/helper", (_req, reply) => reply.header("cache-control", "public").json({ ok: true }));
    app.get("/raw", (_req, reply) => {
      reply.header("cache-control", "public");
      return new Response("raw");
    });

    expect((await app.inject({ url: "/helper" })).headers.get("cache-control")).toBe("private");
    expect((await app.inject({ url: "/raw" })).headers.get("cache-control")).toBe("private");
  });

  it("appends Set-Cookie from the reply to the Response's own cookies", async () => {
    const app = createApp();
    app.get("/login", (_req, reply) => {
      reply.cookie("sid", "abc", { secure: false });
      reply.header("set-cookie", "theme=dark");
      const res = new Response("ok");
      res.headers.append("set-cookie", "own=1");
      return res;
    });

    const res = await app.inject({ url: "/login" });

    expect(res.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual(["own=1", "theme=dark", "sid=abc"]);
  });

  it("appends a cookie set during onSend", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, reply) => {
      reply.cookie("seen", "1", { secure: false });
    });
    app.get("/raw", () => new Response("raw", { headers: { "set-cookie": "own=1" } }));
    app.get("/object", () => ({ ok: true }));

    const raw = await app.inject({ url: "/raw" });
    const object = await app.inject({ url: "/object" });

    expect(raw.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual(["own=1", "seen=1"]);
    expect(object.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual(["seen=1"]);
  });

  it("keeps both Vary values when the Response and the CORS plugin each set one", async () => {
    const app = createApp();
    await app.register(cors({ origin: "https://app.example.com" }));
    app.get("/negotiated", () => new Response("x", { headers: { vary: "Accept-Encoding" } }));

    const res = await app.inject({ url: "/negotiated", headers: { origin: "https://app.example.com" } });

    const vary = (res.headers.get("vary") ?? "").split(",").map((v) => v.trim().toLowerCase());
    expect(vary.sort()).toEqual(["accept-encoding", "origin"]);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
  });

  it("keeps a wildcard Vary from either side", async () => {
    const app = createApp();
    app.get("/own-star", (_req, reply) => {
      reply.header("vary", "Origin");
      return new Response("x", { headers: { vary: "*" } });
    });
    app.get("/reply-star", (_req, reply) => {
      reply.header("vary", "*");
      return new Response("x", { headers: { vary: "Accept-Encoding" } });
    });
    app.get("/same", (_req, reply) => {
      reply.header("vary", "accept-encoding");
      return new Response("x", { headers: { vary: "Accept-Encoding" } });
    });

    expect((await app.inject({ url: "/own-star" })).headers.get("vary")).toBe("*");
    expect((await app.inject({ url: "/reply-star" })).headers.get("vary")).toBe("*");
    expect((await app.inject({ url: "/same" })).headers.get("vary")).toBe("Accept-Encoding");
  });

  it("merges the same way on a 404 as on a routed Response", async () => {
    const app = createApp();
    app.addHook("onRequest", (_req, reply) => {
      reply.header("x-request-id", "req-1");
      reply.header("content-type", "text/plain");
    });
    app.get("/raw", () => new Response("{}", { headers: { "content-type": "application/json" } }));

    const routed = await app.inject({ url: "/raw" });
    const missed = await app.inject({ url: "/missing" });

    for (const res of [routed, missed]) {
      expect(res.headers.get("x-request-id")).toBe("req-1");
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    }
  });
});

describe("reply headers merged into a returned Response over a real socket", () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close();
  });

  it("writes the reply's headers and cookies with the handler's Response", async () => {
    const app = createApp();
    defaultNoStore(app);
    app.get("/limited", (_req, reply) => {
      reply.header("retry-after", "30").cookie("sid", "abc", { secure: false });
      return new Response("slow down", { status: 429, headers: { "cache-control": "public, max-age=5" } });
    });
    const server = await startServer(app);
    servers.push(server);

    const res = await server.send({ path: "/limited" });

    expect(res.status).toBe(429);
    expect(res.body).toBe("slow down");
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.headers["cache-control"]).toBe("public, max-age=5");
    expect(wireCookies(res).map((c) => c.split(";")[0])).toEqual(["sid=abc"]);
  });
});
