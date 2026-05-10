import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("Security headers on error responses", () => {
  it("should include security headers on 404 responses", async () => {
    const app = createApp(); // security enabled by default
    app.get("/exists", (_req, reply) => reply.json({ ok: true }));

    const response = await app.handle(new Request("http://localhost/not-a-route"));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-xss-protection")).toBe("0");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
  });

  it("should include security headers on 405 responses", async () => {
    const app = createApp();
    app.get("/only-get", (_req, reply) => reply.json({ ok: true }));

    const response = await app.handle(new Request("http://localhost/only-get", { method: "POST" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
  });

  it("should NOT include security headers on 404 when security is disabled", async () => {
    const app = createApp({ security: false });
    app.get("/exists", (_req, reply) => reply.json({ ok: true }));

    const response = await app.handle(new Request("http://localhost/nope"));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-content-type-options")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("should use custom security options on error responses", async () => {
    const app = createApp({
      security: { frameOptions: "SAMEORIGIN", contentSecurityPolicy: false },
    });
    app.get("/exists", (_req, reply) => reply.json({ ok: true }));

    const response = await app.handle(new Request("http://localhost/nope"));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("content-security-policy")).toBeNull();
    // Other defaults should still be there
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
