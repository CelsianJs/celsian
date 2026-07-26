// @celsian/core, two documented behaviours that did not exist
//
// 1. `docs/errors.md` promised that 405 responses list the permitted methods in
//    an `Allow` header. Nothing in `packages/core/src` ever set that header.
//    RFC 9110 makes it mandatory on a 405, so the doc was right and the code
//    was wrong: the header is now emitted.
//
// 2. `packages/core/README.md` documented `inject({ cookies })`. `InjectOptions`
//    had no such key, so it was silently dropped and every test written from
//    the README sent no cookies at all while appearing to.

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("Allow header on 405", () => {
  it("lists the methods registered for the path", async () => {
    const app = createApp();
    app.get("/items", () => ({ ok: true }));
    app.post("/items", () => ({ ok: true }));

    const res = await app.inject({ method: "DELETE", url: "/items" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
  });

  it("reports HEAD wherever GET is registered, because the app answers it", async () => {
    const app = createApp();
    app.get("/only-get", () => ({ ok: true }));

    const res = await app.inject({ method: "PUT", url: "/only-get" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("works for param routes", async () => {
    const app = createApp();
    app.patch("/users/:id", () => ({ ok: true }));
    app.delete("/users/:id", () => ({ ok: true }));

    const res = await app.inject({ method: "POST", url: "/users/42" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("PATCH, DELETE");
  });

  it("uses a stable canonical method order, not registration order", async () => {
    const app = createApp();
    app.delete("/z", () => ({ ok: true }));
    app.post("/z", () => ({ ok: true }));
    app.put("/z", () => ({ ok: true }));

    const res = await app.inject({ method: "GET", url: "/z" });

    expect(res.headers.get("allow")).toBe("POST, PUT, DELETE");
  });

  it("does not add Allow to a plain 404", async () => {
    const app = createApp();
    app.get("/exists", () => ({ ok: true }));

    const res = await app.inject({ method: "GET", url: "/nope" });

    expect(res.status).toBe(404);
    expect(res.headers.get("allow")).toBeNull();
  });
});

describe("inject({ cookies })", () => {
  it("sends the cookies to the handler", async () => {
    const app = createApp();
    app.get("/me", (req) => ({ cookies: req.cookies }));

    const res = await app.inject({ url: "/me", cookies: { session: "abc123", theme: "dark" } });

    expect(await res.json()).toEqual({ cookies: { session: "abc123", theme: "dark" } });
  });

  it("percent-encodes values so a cookie carrying a separator survives", async () => {
    const app = createApp();
    app.get("/me", (req) => ({ cookies: req.cookies }));

    const res = await app.inject({ url: "/me", cookies: { token: "a;b=c d" } });

    expect(await res.json()).toEqual({ cookies: { token: "a;b=c d" } });
  });

  it("lets an explicit cookie header win, for hand-crafted malformed cases", async () => {
    const app = createApp();
    app.get("/me", (req) => ({ cookies: req.cookies }));

    const res = await app.inject({
      url: "/me",
      cookies: { ignored: "yes" },
      headers: { cookie: "raw=value" },
    });

    expect(await res.json()).toEqual({ cookies: { raw: "value" } });
  });

  it("sends no cookie header for an empty cookies object", async () => {
    const app = createApp();
    app.get("/me", (req) => ({ hasHeader: req.headers.has("cookie") }));

    const res = await app.inject({ url: "/me", cookies: {} });

    expect(await res.json()).toEqual({ hasHeader: false });
  });
});
