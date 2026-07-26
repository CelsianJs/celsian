// @celsian/core, `Secure` cookie default derived from the request protocol
//
// The bug this guards: `serializeCookie` hardcoded `secure: true` regardless of
// anything. Verified against a dev server on http://192.168.1.50:3000, the
// cookie went out with `Secure`, the browser never sent it back, and the round
// trip returned `{"cookies":{}}`. Login wrote a session that never returned and
// `clearCookie()` logout silently did nothing, both behind a 200.
//
// The framework's own CSRF plugin had already declined this default for itself,
// using `process.env.NODE_ENV === 'production'` instead. Core and the plugin now
// share one policy, see `resolveSecureDefault`.
//
// Reverting to the old NODE_ENV check is NOT the fix either: containers
// routinely run without NODE_ENV, and inferring "not production" from a missing
// env var is what shipped session cookies with no Secure flag originally.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { resetCookieSecurityWarnings, resolveSecureDefault, serializeCookie } from "../src/cookie.js";

beforeEach(() => {
  resetCookieSecurityWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSecureDefault", () => {
  it("is true over HTTPS", () => {
    expect(resolveSecureDefault("https://app.example.com/login")).toBe(true);
    expect(resolveSecureDefault("wss://app.example.com/socket")).toBe(true);
  });

  it("is false over plain HTTP to loopback names and addresses", () => {
    expect(resolveSecureDefault("http://localhost:3000/login")).toBe(false);
    expect(resolveSecureDefault("http://127.0.0.1:3000/login")).toBe(false);
    expect(resolveSecureDefault("http://[::1]:3000/login")).toBe(false);
    expect(resolveSecureDefault("http://app.localhost:3000/login")).toBe(false);
  });

  it("is false over plain HTTP to a private LAN address", () => {
    // The exact case the audit reproduced: a dev server reached from another
    // device on the same network.
    expect(resolveSecureDefault("http://192.168.1.50:3000/login")).toBe(false);
    expect(resolveSecureDefault("http://10.0.0.7:3000/login")).toBe(false);
    expect(resolveSecureDefault("http://172.16.4.2:3000/login")).toBe(false);
    expect(resolveSecureDefault("http://macbook.local:3000/login")).toBe(false);
  });

  it("does not treat 172.32.x.x as private (only 172.16 through 172.31 are)", () => {
    expect(resolveSecureDefault("http://172.32.0.1:3000/login")).toBe(true);
    expect(resolveSecureDefault("http://172.15.0.1:3000/login")).toBe(true);
  });

  it("stays true over plain HTTP to a routable host, and warns loudly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveSecureDefault("http://app.example.com/login")).toBe(true);
    expect(resolveSecureDefault("http://app.example.com/logout")).toBe(true);
    expect(resolveSecureDefault("http://other.example.com/login")).toBe(true);

    // Once per host, not once per cookie.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("app.example.com");
    expect(warn.mock.calls[0]?.[0]).toContain("x-forwarded-proto");
  });

  it("defaults to true when there is no request context or the URL is unparseable", () => {
    expect(resolveSecureDefault(undefined)).toBe(true);
    expect(resolveSecureDefault("not a url")).toBe(true);
  });
});

describe("serializeCookie", () => {
  it("still defaults to Secure when called with no request context", () => {
    // Direct callers (session managers, custom code) have nothing to infer
    // from, so the safe guess stands.
    expect(serializeCookie("session", "xyz")).toContain("Secure");
  });

  it("drops Secure for a plain-HTTP local request", () => {
    expect(serializeCookie("session", "xyz", {}, { url: "http://localhost:3000/login" })).not.toContain("Secure");
  });

  it("honours an explicit secure option over the derived default", () => {
    expect(serializeCookie("s", "v", { secure: true }, { url: "http://localhost:3000/" })).toContain("Secure");
    expect(serializeCookie("s", "v", { secure: false }, { url: "https://app.example.com/" })).not.toContain("Secure");
  });

  it("treats an absent secure option as absent, not as false", () => {
    // `{ ...options }` spread over a default overwrote it with `undefined`
    // whenever a caller passed `secure: undefined` explicitly.
    expect(serializeCookie("s", "v", { secure: undefined }, { url: "https://app.example.com/" })).toContain("Secure");
  });
});

describe("reply.cookie() over plain-HTTP development", () => {
  it("sets a cookie the browser will send back, and reads it on the next request", async () => {
    const app = createApp();
    app.get("/login", (_req, reply) => reply.cookie("session", "abc123").json({ ok: true }));
    app.get("/me", (req, reply) => reply.json({ cookies: req.cookies }));

    const login = await app.inject({ url: "http://192.168.1.50:3000/login" });
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("session=abc123");
    expect(setCookie).not.toContain("Secure");

    // Simulate the browser doing what it would only do without Secure.
    const me = await app.inject({
      url: "http://192.168.1.50:3000/me",
      headers: { cookie: "session=abc123" },
    });
    expect(await me.json()).toEqual({ cookies: { session: "abc123" } });
  });

  it("clearCookie() emits a matching clearing cookie, so logout actually clears", async () => {
    const app = createApp();
    app.get("/logout", (_req, reply) => reply.clearCookie("session").json({ ok: true }));

    const res = await app.inject({ url: "http://localhost:3000/logout" });
    const setCookie = res.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain("session=");
    expect(setCookie).toContain("Max-Age=0");
    // Must match the attributes of the cookie it is clearing, or the browser
    // treats it as a different cookie and the session survives logout.
    expect(setCookie).not.toContain("Secure");
  });

  it("still marks cookies Secure over HTTPS", async () => {
    const app = createApp();
    app.get("/login", (_req, reply) => reply.cookie("session", "abc123").json({ ok: true }));

    const res = await app.inject({ url: "https://app.example.com/login" });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
});
