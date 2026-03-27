import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("app.inject()", () => {
  it("should inject a GET request", async () => {
    const app = createApp();
    app.get("/hello", (_req, reply) => reply.json({ message: "hello" }));

    const response = await app.inject({ url: "/hello" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ message: "hello" });
  });

  it("should inject a POST request with payload", async () => {
    const app = createApp();
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody }));

    const response = await app.inject({
      method: "POST",
      url: "/data",
      payload: { name: "test" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ received: { name: "test" } });
  });

  it("should auto-set content-type for payload", async () => {
    const app = createApp();
    let contentType = "";
    app.post("/check", (req, reply) => {
      contentType = req.headers.get("content-type") ?? "";
      return reply.json({ ok: true });
    });

    await app.inject({
      method: "POST",
      url: "/check",
      payload: { data: true },
    });
    expect(contentType).toBe("application/json");
  });

  it("should support custom headers", async () => {
    const app = createApp();
    app.get("/auth", (req, reply) => {
      return reply.json({ auth: req.headers.get("authorization") });
    });

    const response = await app.inject({
      url: "/auth",
      headers: { authorization: "Bearer token123" },
    });
    const body = await response.json();
    expect(body).toEqual({ auth: "Bearer token123" });
  });

  it("should support query parameters", async () => {
    const app = createApp();
    app.get("/search", (req, reply) => {
      return reply.json({ q: req.query.q, page: req.query.page });
    });

    const response = await app.inject({
      url: "/search",
      query: { q: "hello", page: "2" },
    });
    const body = await response.json();
    expect(body).toEqual({ q: "hello", page: "2" });
  });

  it("should return 404 for non-existent routes", async () => {
    const app = createApp();
    const response = await app.inject({ url: "/nope" });
    expect(response.status).toBe(404);
  });
});
