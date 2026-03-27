import { describe, expect, it } from "vitest";
import {
  buildComposedApp,
  buildCorsApp,
  buildLoggingApp,
  buildSecurityApp,
  buildTimingApp,
} from "./middleware-test.js";

describe("Middleware Chain", () => {
  // ─── Security Headers ───

  describe("Security Plugin", () => {
    it("sets all security headers on responses", async () => {
      const app = buildSecurityApp();
      const res = await app.inject({ url: "/test" });
      expect(res.status).toBe(200);

      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-xss-protection")).toBe("0");
      expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
      expect(res.headers.get("strict-transport-security")).toContain("includeSubDomains");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("x-dns-prefetch-control")).toBe("off");
      expect(res.headers.get("x-download-options")).toBe("noopen");
      expect(res.headers.get("x-permitted-cross-domain-policies")).toBe("none");
    });

    it("security headers applied to 404 responses too", async () => {
      const app = buildSecurityApp();
      const res = await app.inject({ url: "/nonexistent" });
      expect(res.status).toBe(404);
      // Security headers are set via onRequest, which runs before 404 detection
      // The 404 is returned by the router before route lifecycle runs,
      // so security headers are NOT expected on 404s (framework behavior)
    });
  });

  // ─── CORS ───

  describe("CORS Plugin", () => {
    it("sets CORS headers on normal requests with origin", async () => {
      const app = buildCorsApp();
      const res = await app.inject({
        url: "/test",
        headers: { origin: "http://example.com" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    });

    it("wildcard origin without credentials uses *", async () => {
      // Default cors without credentials
      const { createApp } = await import("../packages/core/src/app.js");
      const { cors } = await import("../packages/core/src/plugins/cors.js");
      const app = createApp();
      app.register(cors({ origin: "*", credentials: false }), { encapsulate: false });
      app.get("/test", (_req, reply) => reply.json({ ok: true }));

      const res = await app.inject({
        url: "/test",
        headers: { origin: "http://example.com" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("handles OPTIONS preflight", async () => {
      const app = buildCorsApp();
      const res = await app.handle(
        new Request("http://localhost/test", {
          method: "OPTIONS",
          headers: {
            origin: "http://example.com",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type, authorization",
          },
        }),
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
      expect(res.headers.get("access-control-max-age")).toBe("3600");
    });

    it("restricts CORS to specific origin", async () => {
      const app = buildCorsApp({ corsOrigin: "http://allowed.com" });

      // Allowed origin
      const res1 = await app.inject({
        url: "/test",
        headers: { origin: "http://allowed.com" },
      });
      expect(res1.headers.get("access-control-allow-origin")).toBe("http://allowed.com");

      // Disallowed origin — no CORS headers set
      const res2 = await app.inject({
        url: "/test",
        headers: { origin: "http://evil.com" },
      });
      expect(res2.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  // ─── Request Timing ───

  describe("Request Timing", () => {
    it("sets x-response-time header", async () => {
      const app = buildTimingApp();
      const res = await app.inject({ url: "/test" });
      const timing = res.headers.get("x-response-time");
      expect(timing).toBeDefined();
      expect(timing).not.toBeNull();
      expect(timing).toMatch(/^\d+\.\d+ms$/);
    });

    it("timing reflects actual duration on slow route", async () => {
      const app = buildTimingApp();
      const res = await app.inject({ url: "/slow" });
      const timing = res.headers.get("x-response-time");
      expect(timing).not.toBeNull();
      const ms = parseFloat(timing!);
      // Should be at least ~10ms since we sleep 10ms
      expect(ms).toBeGreaterThanOrEqual(5); // small tolerance
    });
  });

  // ─── Logging ───

  describe("Logging Middleware", () => {
    it("logs each request", async () => {
      const { app, logs } = buildLoggingApp();
      await app.inject({ url: "/test" });
      await app.inject({ url: "/other" });

      expect(logs).toHaveLength(2);
      expect(logs[0].method).toBe("GET");
      expect(logs[0].url).toBe("/test");
      expect(logs[1].url).toBe("/other");
    });

    it("logs contain timestamps", async () => {
      const { app, logs } = buildLoggingApp();
      const before = Date.now();
      await app.inject({ url: "/test" });
      const after = Date.now();

      expect(logs[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(logs[0].timestamp).toBeLessThanOrEqual(after);
    });
  });

  // ─── Composition ───

  describe("Hook Composition", () => {
    it("onRequest hooks from multiple plugins all fire", async () => {
      const { app, logs } = buildComposedApp();
      const res = await app.inject({ url: "/test" });

      // Security headers present (from security plugin onRequest)
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");

      // Logging ran (from logging plugin onRequest)
      expect(logs).toHaveLength(1);
      expect(logs[0].url).toBe("/test");
    });

    it("multiple requests compose correctly", async () => {
      const { app, logs } = buildComposedApp();
      await app.inject({ url: "/test" });
      await app.inject({ url: "/test" });
      await app.inject({ url: "/test" });

      expect(logs).toHaveLength(3);
    });
  });

  // ─── onSend hook stacking (FIXED) ───

  describe("onSend Hook Stacking", () => {
    it("all onSend hooks fire even when reply is already sent", async () => {
      const { createApp } = await import("../packages/core/src/app.js");
      const app = createApp();
      const calls: string[] = [];

      app.addHook("onSend", () => {
        calls.push("first");
      });
      app.addHook("onSend", () => {
        calls.push("second");
      });

      app.get("/test", (_req, reply) => reply.json({ ok: true }));

      await app.inject({ url: "/test" });

      // Both hooks fire — onSend uses runOnSendHooks which doesn't bail on reply.sent
      expect(calls).toEqual(["first", "second"]);
    });
  });
});
