import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { cors } from "../src/plugins/cors.js";

describe("CORS Plugin", () => {
  it("should require explicit origin configuration", () => {
    expect(() => (cors as any)()).toThrow("CORS origin is required");
    expect(() => (cors as any)({})).toThrow("CORS origin is required");
  });

  it("should reject wildcard origin with credentials", () => {
    expect(() => cors({ origin: "*", credentials: true })).toThrow("incompatible with credentials:true");
  });

  it("should handle OPTIONS preflight with 204", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "*" }));
    app.get("/api/data", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/data",
      headers: { origin: "http://example.com" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("should set CORS headers on regular requests", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "*" }));
    app.get("/api/data", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      url: "/api/data",
      headers: { origin: "http://example.com" },
    });
    expect(response.status).toBe(200);
  });

  it("should respect specific origin", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "http://allowed.com" }));
    app.get("/api/data", (_req, reply) => reply.json({ ok: true }));

    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/data",
      headers: { origin: "http://allowed.com" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://allowed.com");
  });

  it("should support array of origins", async () => {
    const app = createApp({ security: false });
    await app.register(
      cors({
        origin: ["http://a.com", "http://b.com"],
      }),
    );
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: { origin: "http://b.com" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://b.com");
  });

  it("should support origin function", async () => {
    const app = createApp({ security: false });
    await app.register(
      cors({
        origin: (o) => o.endsWith(".example.com"),
      }),
    );
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: { origin: "http://app.example.com" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://app.example.com");
  });

  it("should include credentials header when enabled", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "http://example.com", credentials: true }));
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: { origin: "http://example.com" },
    });
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("should include max-age on preflight", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "*", maxAge: 3600 }));
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: { origin: "http://example.com" },
    });
    expect(response.headers.get("access-control-max-age")).toBe("3600");
  });

  it("should include allowed methods", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "*", methods: ["GET", "POST"] }));
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: { origin: "http://example.com" },
    });
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST");
  });

  // ─── BUG-12: CORS should not leak headers to disallowed origins ───

  it("should not leak CORS headers for disallowed origins on preflight", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "http://allowed.com" }));
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: { origin: "http://evil.com" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
  });

  it("should not set CORS headers on actual requests from disallowed origins", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "http://allowed.com" }), { encapsulate: false });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      url: "/test",
      headers: { origin: "http://evil.com" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("should apply CORS headers to actual requests from allowed origins", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "http://allowed.com" }), { encapsulate: false });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      url: "/test",
      headers: { origin: "http://allowed.com" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://allowed.com");
  });

  // ─── Vary: Origin for non-wildcard origins ───

  it("should add Vary: Origin on preflight when origin is not wildcard", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "http://allowed.com" }));
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: { origin: "http://allowed.com" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("vary")).toMatch(/origin/i);
  });

  it("should add Vary: Origin on actual requests when origin is not wildcard", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "http://allowed.com" }), { encapsulate: false });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      url: "/test",
      headers: { origin: "http://allowed.com" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toMatch(/origin/i);
  });

  it("should NOT add Vary: Origin when origin is wildcard *", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "*" }), { encapsulate: false });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: { origin: "http://example.com" },
    });
    expect(preflight.headers.get("vary")).toBeNull();

    const actual = await app.inject({
      url: "/test",
      headers: { origin: "http://example.com" },
    });
    expect(actual.headers.get("vary")).toBeNull();
  });

  it("should add Vary: Origin for array origins on preflight and actual requests", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: ["http://a.com", "http://b.com"] }), { encapsulate: false });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: { origin: "http://a.com" },
    });
    expect(preflight.headers.get("vary")).toMatch(/origin/i);

    const actual = await app.inject({
      url: "/test",
      headers: { origin: "http://b.com" },
    });
    expect(actual.headers.get("vary")).toMatch(/origin/i);
  });

  it("should append to existing Vary header without overwriting", async () => {
    const app = createApp({ security: false });
    await app.register(cors({ origin: "http://allowed.com" }), { encapsulate: false });
    app.get("/test", (_req, reply) => {
      reply.header("vary", "Accept-Encoding");
      return reply.json({ ok: true });
    });

    const response = await app.inject({
      url: "/test",
      headers: { origin: "http://allowed.com" },
    });
    const vary = response.headers.get("vary") ?? "";
    expect(vary).toMatch(/Accept-Encoding/);
    expect(vary).toMatch(/Origin/i);
  });
});
