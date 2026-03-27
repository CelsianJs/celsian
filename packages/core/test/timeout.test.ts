import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("Request Timeout", () => {
  it("should return 504 when handler exceeds timeout", async () => {
    const app = createApp({ requestTimeout: 100 });
    app.get("/slow", async (_req, reply) => {
      await new Promise((r) => setTimeout(r, 500));
      return reply.json({ ok: true });
    });

    const response = await app.inject({ url: "/slow" });
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toContain("Gateway Timeout");
  });

  it("should not timeout fast handlers", async () => {
    const app = createApp({ requestTimeout: 1000 });
    app.get("/fast", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/fast" });
    expect(response.status).toBe(200);
  });

  it("should allow disabling timeout with 0", async () => {
    const app = createApp({ requestTimeout: 0 });
    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.status).toBe(200);
  });
});
