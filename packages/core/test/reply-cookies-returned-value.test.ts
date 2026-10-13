// @celsian/core, cookies set on the reply survive a handler that returns data
//
// `reply.cookie()` must reach the client whether the handler finishes with
// `reply.json(...)`, returns a plain object or string for auto-serialization, or
// returns nothing at all (204). Checked through `inject()` and on the wire,
// because the Node adapter writes auto-serialized responses through a separate
// fast path.

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { csrf } from "../src/plugins/csrf.js";
import { type RawResponse, startServer, type TestServer } from "./helpers/raw-http.js";

/** The Set-Cookie values a raw response carried, one entry per header line. */
function wireCookies(res: RawResponse): string[] {
  const value = res.headers["set-cookie"];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function cookieApp() {
  const app = createApp();
  app.get("/object", (_req, reply) => {
    reply.cookie("sid", "abc", { httpOnly: true, secure: false });
    return { ok: true };
  });
  app.get("/string", (_req, reply) => {
    reply.cookie("sid", "abc", { secure: false });
    return "ok";
  });
  app.post("/nothing", (_req, reply) => {
    reply.cookie("sid", "abc", { secure: false });
  });
  app.get("/two", (_req, reply) => {
    reply.cookie("a", "1", { secure: false }).cookie("b", "2", { secure: false });
    return { ok: true };
  });
  app.get("/json-helper", (_req, reply) => {
    reply.cookie("sid", "abc", { secure: false });
    return reply.json({ ok: true });
  });
  return app;
}

describe("reply cookies with a returned value", () => {
  it("keeps the cookie when the handler returns a plain object", async () => {
    const res = await cookieApp().inject({ url: "/object" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^sid=abc;.*HttpOnly/)]);
  });

  it("keeps the cookie when the handler returns a string", async () => {
    const res = await cookieApp().inject({ url: "/string" });

    expect(await res.text()).toBe("ok");
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^sid=abc;/)]);
  });

  it("keeps the cookie when the handler returns nothing", async () => {
    const res = await cookieApp().inject({ method: "POST", url: "/nothing" });

    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^sid=abc;/)]);
  });

  it("keeps every cookie, in order", async () => {
    const res = await cookieApp().inject({ url: "/two" });

    expect(res.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual(["a=1", "b=2"]);
  });

  it("does not duplicate a cookie the reply helper already wrote", async () => {
    const res = await cookieApp().inject({ url: "/json-helper" });

    expect(res.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual(["sid=abc"]);
  });
});

describe("reply cookies with a returned value over a real socket", () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close();
  });

  it("writes the cookies of an auto-serialized object to the wire", async () => {
    const server = await startServer(cookieApp());
    servers.push(server);

    const res = await server.send({ path: "/two" });

    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(wireCookies(res).map((c) => c.split(";")[0])).toEqual(["a=1", "b=2"]);
  });

  it("writes a header-set cookie and a reply.cookie() cookie together", async () => {
    // The CSRF plugin issues its token with reply.header("set-cookie", ...),
    // while the handler adds a session with reply.cookie(). Both must arrive.
    const app = createApp();
    await app.register(csrf());
    app.get("/page", (_req, reply) => {
      reply.cookie("sid", "abc", { secure: false });
      return { ok: true };
    });
    app.get("/page-json", (_req, reply) => reply.cookie("sid", "abc", { secure: false }).json({ ok: true }));
    const server = await startServer(app);
    servers.push(server);

    const names: Record<string, string[]> = {};
    for (const path of ["/page", "/page-json"]) {
      const res = await server.send({ path });
      names[path] = wireCookies(res)
        .map((c) => c.split("=")[0] ?? "")
        .sort();
    }
    expect(names).toEqual({ "/page": ["_csrf", "sid"], "/page-json": ["_csrf", "sid"] });
  });
});
