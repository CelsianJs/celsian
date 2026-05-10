import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("setNotFoundHandler", () => {
  it("should use custom 404 handler when set", async () => {
    const app = createApp();
    app.get("/exists", (_req, reply) => reply.json({ ok: true }));

    app.setNotFoundHandler((_req, reply) => {
      return reply.status(404).html("<h1>Page Not Found</h1>");
    });

    const response = await app.handle(new Request("http://localhost/nope"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body).toBe("<h1>Page Not Found</h1>");
  });

  it("should return custom JSON from not-found handler", async () => {
    const app = createApp();
    app.setNotFoundHandler((_req, reply) => {
      return reply.status(404).json({ error: "Custom not found", path: "unknown" });
    });

    const response = await app.handle(new Request("http://localhost/missing"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Custom not found");
  });

  it("should still return default 404 when no custom handler", async () => {
    const app = createApp();
    const response = await app.handle(new Request("http://localhost/nope"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("should still return 405 for wrong method even with custom 404 handler", async () => {
    const app = createApp();
    app.get("/users", (_req, reply) => reply.json([]));
    app.setNotFoundHandler((_req, reply) => reply.status(404).html("Not Found"));

    const response = await app.handle(new Request("http://localhost/users", { method: "DELETE" }));
    expect(response.status).toBe(405);
  });
});

describe("spaFallback", () => {
  it("should serve custom HTML for unmatched routes via handler", async () => {
    const app = createApp({ security: false });
    app.get("/api/data", (_req, reply) => reply.json({ ok: true }));

    app.spaFallback((_req, reply) => {
      return reply.html("<html><body><div id='app'></div></body></html>");
    });

    // API route still works
    const apiRes = await app.handle(new Request("http://localhost/api/data"));
    expect(apiRes.status).toBe(200);
    const data = await apiRes.json();
    expect(data.ok).toBe(true);

    // Unknown routes get the SPA HTML
    const spaRes = await app.handle(new Request("http://localhost/dashboard"));
    expect(spaRes.status).toBe(200);
    const body = await spaRes.text();
    expect(body).toContain("<div id='app'></div>");
  });

  it("should still return 405 for wrong method with SPA fallback", async () => {
    const app = createApp({ security: false });
    app.get("/api/users", (_req, reply) => reply.json([]));

    app.spaFallback((_req, reply) => reply.html("<html></html>"));

    const response = await app.handle(new Request("http://localhost/api/users", { method: "DELETE" }));
    expect(response.status).toBe(405);
  });
});

describe("setErrorHandler", () => {
  it("should use custom error handler", async () => {
    const app = createApp();

    app.setErrorHandler((error, _req, reply) => {
      return reply.status(500).json({ customError: true, message: error.message });
    });

    app.get("/fail", () => {
      throw new Error("Boom");
    });

    const response = await app.handle(new Request("http://localhost/fail"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.customError).toBe(true);
    expect(body.message).toBe("Boom");
  });

  it("should fall back to default error handler if custom throws", async () => {
    const app = createApp();

    app.setErrorHandler(() => {
      throw new Error("handler also broke");
    });

    app.get("/fail", () => {
      throw new Error("Original error");
    });

    const response = await app.handle(new Request("http://localhost/fail"));
    expect(response.status).toBe(500);
  });
});
