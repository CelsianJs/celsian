import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { security } from "../src/plugins/security.js";

describe("Security Headers Plugin", () => {
  it("should add default security headers automatically", async () => {
    const app = createApp();
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-xss-protection")).toBe("0");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
    expect(response.headers.get("x-download-options")).toBe("noopen");
    expect(response.headers.get("x-permitted-cross-domain-policies")).toBe("none");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
  });

  it("should allow disabling all security headers via app options", async () => {
    const app = createApp({ security: false });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("should allow customizing security headers via app options", async () => {
    const app = createApp({
      security: {
        frameOptions: "SAMEORIGIN",
        contentSecurityPolicy: "default-src 'self'; script-src 'self' cdn.example.com",
      },
    });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self' cdn.example.com",
    );
  });

  it("should allow disabling security headers via enabled:false in plugin", async () => {
    const app = createApp({ security: false });
    await app.register(security({ enabled: false }), { encapsulate: false });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.headers.get("x-content-type-options")).toBeNull();
  });

  it("should allow disabling individual headers via explicit plugin registration", async () => {
    const app = createApp({ security: false });
    await app.register(
      security({
        frameOptions: false,
        hsts: false,
        xssProtection: false,
        contentSecurityPolicy: false,
      }),
      { encapsulate: false },
    );
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("x-xss-protection")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("should support SAMEORIGIN frame option", async () => {
    const app = createApp({ security: false });
    await app.register(security({ frameOptions: "SAMEORIGIN" }), { encapsulate: false });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("should support custom HSTS options", async () => {
    const app = createApp({ security: false });
    await app.register(
      security({
        hsts: { maxAge: 86400, includeSubDomains: false, preload: true },
      }),
      { encapsulate: false },
    );
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    const hsts = response.headers.get("strict-transport-security");
    expect(hsts).toBe("max-age=86400; preload");
  });

  it("should support Content-Security-Policy", async () => {
    const app = createApp({ security: false });
    await app.register(
      security({
        contentSecurityPolicy: "default-src 'self'",
      }),
      { encapsulate: false },
    );
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
  });
});
