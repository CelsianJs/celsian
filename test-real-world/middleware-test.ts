// Real-world test: Middleware chain composition

import type { CelsianApp } from "../packages/core/src/app.js";
import { createApp } from "../packages/core/src/app.js";
import { cors } from "../packages/core/src/plugins/cors.js";
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
  // Security headers are enabled by default, but we also register explicit options here
  const app = createApp({
    security: {
      contentTypeOptions: true,
      frameOptions: "DENY",
      hsts: { maxAge: 31536000, includeSubDomains: true },
    },
  });

  app.get("/test", (_req, reply) => reply.json({ ok: true }));
  return app;
}

// ─── App with CORS only ───

export function buildCorsApp(options?: { corsOrigin?: string | string[] }): CelsianApp {
  const app = createApp({ security: false });

  app.register(
    cors({
      origin: options?.corsOrigin ?? (() => true),
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
  // createApp() auto-registers security headers by default — no need to register manually
  const app = createApp();
  const { plugin: logPlugin, logs } = createRequestLogger();

  // Logging via onRequest
  app.register(logPlugin, { encapsulate: false });

  app.get("/test", (_req, reply) => reply.json({ ok: true }));

  return { app, logs };
}
