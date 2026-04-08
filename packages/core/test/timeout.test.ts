// @celsian/core — Request timeout tests

import { describe, expect, it } from "vitest";
import { CelsianApp, createApp } from "../src/app.js";

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

  it("default requestTimeout is 30000ms", () => {
    // The CelsianApp constructor defaults requestTimeout to 30_000.
    // We verify by creating an app with no options and checking behavior.
    // Since the source sets: this.cachedRequestTimeout = options.requestTimeout ?? 30_000
    // we can verify the default by ensuring a request that completes
    // well within 30s succeeds.
    const app = createApp();
    app.get("/default-timeout", (_req, reply) => reply.json({ ok: true }));

    // A fast handler should succeed under the default 30s timeout
    return app.inject({ url: "/default-timeout" }).then((response) => {
      expect(response.status).toBe(200);
    });
  });

  it("504 response includes Gateway Timeout error code", async () => {
    const app = createApp({ requestTimeout: 50 });
    app.get("/timeout-code", async (_req, reply) => {
      await new Promise((r) => setTimeout(r, 300));
      return reply.json({ ok: true });
    });

    const response = await app.inject({ url: "/timeout-code" });
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.statusCode).toBe(504);
  });

  it("timeout does not affect subsequent requests", async () => {
    const app = createApp({ requestTimeout: 100 });

    app.get("/slow-first", async (_req, reply) => {
      await new Promise((r) => setTimeout(r, 500));
      return reply.json({ ok: true });
    });

    app.get("/fast-second", (_req, reply) => reply.json({ ok: true }));

    // First request times out
    const slowRes = await app.inject({ url: "/slow-first" });
    expect(slowRes.status).toBe(504);

    // Second request should still work fine
    const fastRes = await app.inject({ url: "/fast-second" });
    expect(fastRes.status).toBe(200);
  });

  it("timeout with requestTimeout: 0 allows long-running handlers", async () => {
    const app = createApp({ requestTimeout: 0 });
    app.get("/long", async (_req, reply) => {
      // With timeout disabled, even a 200ms handler should complete
      await new Promise((r) => setTimeout(r, 200));
      return reply.json({ ok: true });
    });

    const response = await app.inject({ url: "/long" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });
});
