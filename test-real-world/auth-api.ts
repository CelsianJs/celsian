// Real-world test: Auth middleware with protected routes

import type { CelsianApp } from "../packages/core/src/app.js";
import { createApp } from "../packages/core/src/app.js";
import type { PluginFunction } from "../packages/core/src/types.js";

// Simple token store (in real world, use JWT)
const VALID_USERS = new Map([
  ["admin", { id: "1", username: "admin", role: "admin", password: "secret123" }],
  ["user1", { id: "2", username: "user1", role: "user", password: "pass456" }],
]);

const tokens = new Map<string, { userId: string; username: string; role: string }>();

function generateToken(): string {
  return `tok_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// Public routes plugin (no auth required)
const publicRoutes: PluginFunction = (app) => {
  app.post("/login", (req, reply) => {
    const body = req.parsedBody as { username?: string; password?: string } | undefined;
    if (!body?.username || !body?.password) {
      return reply.badRequest("Username and password are required");
    }

    const user = VALID_USERS.get(body.username);
    if (!user || user.password !== body.password) {
      return reply.unauthorized("Invalid credentials");
    }

    const token = generateToken();
    tokens.set(token, { userId: user.id, username: user.username, role: user.role });

    return reply.json({ token, expiresIn: 3600 });
  });

  app.get("/public", (_req, reply) => {
    return reply.json({ message: "This is public" });
  });
};

// Protected routes plugin (auth required via onRequest hook)
const protectedRoutes: PluginFunction = (app) => {
  // Auth hook applied to all routes in this plugin
  app.addHook("onRequest", (req, reply) => {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.unauthorized("Missing or invalid authorization header");
    }

    const token = authHeader.slice(7);
    const session = tokens.get(token);
    if (!session) {
      return reply.unauthorized("Invalid or expired token");
    }

    // Attach user info to request
    (req as Record<string, unknown>).user = session;
  });

  app.get("/profile", (req, reply) => {
    const user = (req as Record<string, unknown>).user as { userId: string; username: string; role: string };
    return reply.json({
      userId: user.userId,
      username: user.username,
      role: user.role,
    });
  });

  app.get("/admin", (req, reply) => {
    const user = (req as Record<string, unknown>).user as { userId: string; username: string; role: string };
    if (user.role !== "admin") {
      return reply.forbidden("Admin access required");
    }
    return reply.json({ message: "Admin area", user: user.username });
  });
};

export function buildAuthApp(): CelsianApp {
  const app = createApp();

  // Public routes — no encapsulation, hooks don't leak
  app.register(publicRoutes);

  // Protected routes — encapsulated, auth hook applies only here
  app.register(protectedRoutes, { prefix: "/api" });

  return app;
}

// Export for testing
export { tokens };
