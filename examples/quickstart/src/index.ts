// CelsianJS Quickstart — Todo API with Auth
//
// A realistic starter template demonstrating:
//   - createApp() with logging
//   - Built-in plugins: CORS, security headers, rate limiting
//   - Health check endpoint
//   - Modular route registration (todos + auth)
//   - JWT authentication with protected routes
//   - Schema validation with Zod
//   - Graceful shutdown
//
// Run:  pnpm dev        (hot-reload via tsx)
// Test: pnpm test       (vitest with app.inject — no server needed)

import { cors, createApp, serve } from "@celsian/core";
import type { JWTNamespace } from "@celsian/jwt";
import { jwt } from "@celsian/jwt";
import { rateLimit } from "@celsian/rate-limit";
import { JWT_SECRET, setJwtInstance } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { todoRoutes } from "./routes/todos.js";

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";

export function buildApp() {
  const app = createApp({ logger: true });

  // ─── Plugins ───
  // Security headers are enabled by default via createApp().
  // Each plugin is registered with { encapsulate: false } so its hooks
  // apply globally (not scoped to a child context).

  app.register(cors({ origin: CORS_ORIGIN }), { encapsulate: false });
  app.register(rateLimit({ max: 100, window: 60_000 }), { encapsulate: false });

  // Register JWT plugin at the app level — decorates app with `jwt.sign()` and `jwt.verify()`
  app.register(jwt({ secret: JWT_SECRET }), { encapsulate: false }).then(() => {
    // Store the JWT instance so auth routes can use it
    const jwtNs = app.getDecoration("jwt") as JWTNamespace;
    setJwtInstance(jwtNs);
  });

  // ─── Health Check ───
  // GET /health  — liveness probe
  // GET /ready   — readiness probe (waits for all plugins to load)

  app.health();

  // ─── Routes ───
  // Registered as plugins so each module is self-contained.

  app.register(todoRoutes, { encapsulate: false });
  app.register(authRoutes, { encapsulate: false });

  return app;
}

// ─── Start Server (only when run directly, not during tests) ───

const isMainModule = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMainModule) {
  const app = buildApp();
  await app.ready();

  serve(app, {
    port: parseInt(process.env.PORT ?? "3000", 10),
    onReady({ port, host }) {
      console.log(`Quickstart API ready at http://${host}:${port}`);
    },
    async onShutdown() {
      console.log("Cleanup complete");
    },
  });
}
