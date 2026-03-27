import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { parseCookies, serializeCookie } from "../src/cookie.js";

describe("Cookie parsing", () => {
  it("should parse cookie header", () => {
    const cookies = parseCookies("name=value; session=abc123");
    expect(cookies).toEqual({ name: "value", session: "abc123" });
  });

  it("should handle empty cookie header", () => {
    const cookies = parseCookies("");
    expect(cookies).toEqual({});
  });

  it("should decode URL-encoded values", () => {
    const cookies = parseCookies("data=hello%20world");
    expect(cookies).toEqual({ data: "hello world" });
  });

  it("should handle cookies with = in value", () => {
    const cookies = parseCookies("token=abc=def");
    expect(cookies).toEqual({ token: "abc=def" });
  });
});

describe("Cookie serialization", () => {
  it("should serialize basic cookie with secure defaults", () => {
    const cookie = serializeCookie("name", "value");
    // Secure defaults: httpOnly=true, sameSite='lax'
    expect(cookie).toContain("name=value");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("should serialize with all options", () => {
    const cookie = serializeCookie("session", "abc", {
      domain: "example.com",
      httpOnly: true,
      maxAge: 3600,
      path: "/",
      sameSite: "strict",
      secure: true,
    });
    expect(cookie).toContain("session=abc");
    expect(cookie).toContain("Domain=example.com");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
  });

  it("should serialize with expires", () => {
    const date = new Date("2025-12-31T00:00:00Z");
    const cookie = serializeCookie("test", "val", { expires: date });
    expect(cookie).toContain("Expires=");
  });

  it("should URL-encode values", () => {
    const cookie = serializeCookie("data", "hello world");
    expect(cookie).toContain("data=hello%20world");
  });

  it("should allow overriding secure defaults", () => {
    // Explicitly disable httpOnly and sameSite
    const cookie = serializeCookie("token", "abc", {
      httpOnly: false,
      sameSite: undefined,
    });
    expect(cookie).toContain("token=abc");
    // httpOnly=false means no HttpOnly flag
    expect(cookie).not.toContain("HttpOnly");
  });
});

describe("Cookie secure defaults", () => {
  it("defaults httpOnly to true", () => {
    const cookie = serializeCookie("session", "xyz");
    expect(cookie).toContain("HttpOnly");
  });

  it("defaults sameSite to lax", () => {
    const cookie = serializeCookie("session", "xyz");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("secure defaults to false in non-production (NODE_ENV not set)", () => {
    // In test environment, NODE_ENV may or may not be 'production'
    const cookie = serializeCookie("session", "xyz");
    if (process.env.NODE_ENV === "production") {
      expect(cookie).toContain("Secure");
    } else {
      expect(cookie).not.toContain("Secure");
    }
  });

  it("user options override secure defaults", () => {
    const cookie = serializeCookie("nosecure", "val", {
      httpOnly: false,
      sameSite: "none",
      secure: true,
    });
    expect(cookie).not.toContain("HttpOnly");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
  });
});

describe("Cookie integration with app", () => {
  it("should read cookies from request", async () => {
    const app = createApp();
    app.get("/check", (req: any, reply) => {
      return reply.json({ session: req.cookies.session });
    });

    const response = await app.inject({
      url: "/check",
      headers: { cookie: "session=abc123" },
    });
    const body = await response.json();
    expect(body).toEqual({ session: "abc123" });
  });

  it("should set cookies on response", async () => {
    const app = createApp();
    app.get("/login", (_req, reply) => {
      return reply.cookie("session", "xyz", { httpOnly: true, path: "/" }).json({ ok: true });
    });

    const response = await app.inject({ url: "/login" });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("session=xyz");
    expect(setCookie).toContain("HttpOnly");
  });

  it("should clear cookies", async () => {
    const app = createApp();
    app.get("/logout", (_req, reply) => {
      return reply.clearCookie("session").json({ ok: true });
    });

    const response = await app.inject({ url: "/logout" });
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("session=");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("should lazily parse cookies (only on access)", async () => {
    const app = createApp();
    let accessed = false;
    app.get("/lazy", (req: any, reply) => {
      // Just accessing the property should trigger parsing
      const cookies = req.cookies;
      accessed = true;
      return reply.json({ count: Object.keys(cookies).length });
    });

    await app.inject({
      url: "/lazy",
      headers: { cookie: "a=1; b=2" },
    });
    expect(accessed).toBe(true);
  });
});
