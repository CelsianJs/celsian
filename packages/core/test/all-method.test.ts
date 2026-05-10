import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("app.all()", () => {
  it("should handle GET requests", async () => {
    const app = createApp();
    app.all("/any", (_req, reply) => reply.json({ method: "matched" }));

    const res = await app.handle(new Request("http://localhost/any"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("matched");
  });

  it("should handle POST requests", async () => {
    const app = createApp();
    app.all("/any", (_req, reply) => reply.json({ ok: true }));

    const res = await app.handle(new Request("http://localhost/any", { method: "POST" }));
    expect(res.status).toBe(200);
  });

  it("should handle PUT requests", async () => {
    const app = createApp();
    app.all("/any", (_req, reply) => reply.json({ ok: true }));

    const res = await app.handle(new Request("http://localhost/any", { method: "PUT" }));
    expect(res.status).toBe(200);
  });

  it("should handle PATCH requests", async () => {
    const app = createApp();
    app.all("/any", (_req, reply) => reply.json({ ok: true }));

    const res = await app.handle(new Request("http://localhost/any", { method: "PATCH" }));
    expect(res.status).toBe(200);
  });

  it("should handle DELETE requests", async () => {
    const app = createApp();
    app.all("/any", (_req, reply) => reply.json({ ok: true }));

    const res = await app.handle(new Request("http://localhost/any", { method: "DELETE" }));
    expect(res.status).toBe(200);
  });

  it("should handle HEAD requests", async () => {
    const app = createApp();
    app.all("/any", (_req, reply) => reply.json({ ok: true }));

    const res = await app.handle(new Request("http://localhost/any", { method: "HEAD" }));
    expect(res.status).toBe(200);
  });

  it("should handle OPTIONS requests", async () => {
    const app = createApp();
    app.all("/any", (_req, reply) => reply.json({ ok: true }));

    const res = await app.handle(new Request("http://localhost/any", { method: "OPTIONS" }));
    expect(res.status).toBe(200);
  });

  it("should work with route params", async () => {
    const app = createApp();
    app.all("/items/:id", (req, reply) => reply.json({ id: req.params.id }));

    const res = await app.handle(new Request("http://localhost/items/42", { method: "PATCH" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("42");
  });

  it("should not match paths not registered", async () => {
    const app = createApp();
    app.all("/registered", (_req, reply) => reply.json({ ok: true }));

    const res = await app.handle(new Request("http://localhost/other"));
    expect(res.status).toBe(404);
  });
});
