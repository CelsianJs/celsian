// Real-world test: Middleware chain composition

import type { CelsianApp } from "../packages/core/src/app.js";
import { createApp } from "../packages/core/src/app.js";
import { cors } from "../packages/core/src/plugins/cors.js";
import { security } from "../packages/core/src/plugins/security.js";
import type { HookHandler, PluginFunction } from "../packages/core/src/types.js";

// Custom logging middleware that collects log entries
export interface LogEntry {
  method: string;
  url: string;
  timestamp: number;
}

export function createRequestLogger() {
  const logs: LogEntry[] = [];

  const plugin: PluginFunction = (app) => {
    app.addHook("onRequest", (req) => {
      logs.push({
        method: req.method,
        url: new URL(req.url).pathname,
        timestamp: Date.now(),
      });
    });
  };

  return { plugin, logs };
}

// ─── App with security headers only (no CORS to avoid onSend bug) ───

export function buildSecurityApp(): CelsianApp {
  const app = createApp();

  app.register(
    security({
      contentTypeOptions: true,
      frameOptions: "DENY",
      hsts: { maxAge: 31536000, includeSubDomains: true },
    }),
    { encapsulate: false },
  );

  app.get("/test", (_req, reply) => reply.json({ ok: true }));
  return app;
}

// ─── App with CORS only ───

export function buildCorsApp(options?: { corsOrigin?: string | string[] }): CelsianApp {
  const app = createApp();

  // Use a specific origin when credentials are enabled (wildcard + credentials
  // is forbidden by browsers and now throws a CelsianError).
  const origin = options?.corsOrigin ?? "http://example.com";

  app.register(
    cors({
      origin,
      credentials: true,
      maxAge: 3600,
    }),
    { encapsulate: false },
  );

  app.get("/test", (_req, reply) => reply.json({ ok: true }));
  return app;
}

// ─── App with request timing (uses route-level onSend to avoid the bug) ───

export function buildTimingApp(): CelsianApp {
  const app = createApp();

  // Request timing via onRequest + route-level onSend
  const timingOnRequest: HookHandler = (req) => {
    (req as Record<string, unknown>)._startTime = performance.now();
  };
  const timingOnSend: HookHandler = (req, reply) => {
    const start = (req as Record<string, unknown>)._startTime as number;
    if (start) {
      const duration = (performance.now() - start).toFixed(2);
      reply.header("x-response-time", `${duration}ms`);
    }
  };

  app.addHook("onRequest", timingOnRequest);

  // Register routes with route-level onSend to set the timing header
  app.route({
    method: "GET",
    url: "/test",
    onSend: timingOnSend,
    handler: (_req, reply) => reply.json({ ok: true }),
  });

  app.route({
    method: "GET",
    url: "/slow",
    onSend: timingOnSend,
    handler: async (_req, reply) => {
      await new Promise((r) => setTimeout(r, 10));
      return reply.json({ slow: true });
    },
  });

  return app;
}

// ─── App with logging middleware ───

export function buildLoggingApp(): { app: CelsianApp; logs: LogEntry[] } {
  const app = createApp();
  const { plugin: logPlugin, logs } = createRequestLogger();

  app.register(logPlugin, { encapsulate: false });

  app.get("/test", (_req, reply) => reply.json({ ok: true }));
  app.get("/other", (_req, reply) => reply.json({ other: true }));

  return { app, logs };
}

// ─── Combined app for composition testing ───

export function buildComposedApp(): { app: CelsianApp; logs: LogEntry[] } {
  const app = createApp();
  const { plugin: logPlugin, logs } = createRequestLogger();

  // Security headers via onRequest — doesn't conflict with other hooks
  app.register(security(), { encapsulate: false });

  // Logging via onRequest
  app.register(logPlugin, { encapsulate: false });

  app.get("/test", (_req, reply) => reply.json({ ok: true }));

  return { app, logs };
}
