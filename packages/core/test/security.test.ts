import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { security } from "../src/plugins/security.js";

describe("Security Headers Plugin", () => {
  it("should add default security headers", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
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
  });

  it("should allow disabling individual headers", async () => {
    const app = createApp();
    await app.register(
      security({
        frameOptions: false,
        hsts: false,
        xssProtection: false,
      }),
      { encapsulate: false },
    );
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("x-xss-protection")).toBeNull();
  });

  it("should support SAMEORIGIN frame option", async () => {
    const app = createApp();
    await app.register(security({ frameOptions: "SAMEORIGIN" }), { encapsulate: false });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("should support custom HSTS options", async () => {
    const app = createApp();
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
    const app = createApp();
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
