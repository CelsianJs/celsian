import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { cors } from "../src/plugins/cors.js";

describe("CORS Plugin", () => {
  it("should handle OPTIONS preflight with 204", async () => {
    const app = createApp();
    await app.register(cors());
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
    const app = createApp();
    await app.register(cors());
    app.get("/api/data", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      url: "/api/data",
      headers: { origin: "http://example.com" },
    });
    expect(response.status).toBe(200);
  });

  it("should respect specific origin", async () => {
    const app = createApp();
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
    const app = createApp();
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
    const app = createApp();
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
    const app = createApp();
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
    const app = createApp();
    await app.register(cors({ maxAge: 3600 }));
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/test",
      headers: { origin: "http://example.com" },
    });
    expect(response.headers.get("access-control-max-age")).toBe("3600");
  });

  it("should include allowed methods", async () => {
    const app = createApp();
    await app.register(cors({ methods: ["GET", "POST"] }));
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
    const app = createApp();
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
    const app = createApp();
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
    const app = createApp();
    await app.register(cors({ origin: "http://allowed.com" }), { encapsulate: false });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      url: "/test",
      headers: { origin: "http://allowed.com" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://allowed.com");
  });
});
