// SaaS Backend in One File — CelsianJS Demo
// Demonstrates: JWT auth, CRUD, background tasks, cron, SSE, OpenAPI, Zod validation

import {
  cors,
  createApp,
  createSSEHub,
  HttpError,
  openapi,
  serve,
} from "@celsian/core";
import { createJWTGuard, jwt } from "@celsian/jwt";
import { z } from "zod";

// ─── Config ───

const JWT_SECRET = process.env.JWT_SECRET ?? "celsian-demo-secret-change-me";
const PORT = Number(process.env.PORT ?? 3000);

// ─── In-Memory Data Store ───

interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: "admin" | "user";
  createdAt: string;
}

const users = new Map<string, User>();
const emailIndex = new Map<string, string>(); // email -> user id
let nextId = 1;

function hashPassword(password: string): string {
  // Simple hash for demo purposes — use bcrypt/argon2 in production
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    hash = (hash << 5) - hash + password.charCodeAt(i);
    hash |= 0;
  }
  return `demo$${hash.toString(36)}`;
}

// ─── App Setup ───

const app = createApp({ logger: true });

// Plugins (security headers enabled by default)
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";
await app.register(cors({ origin: CORS_ORIGIN }), { encapsulate: false });
await app.register(jwt({ secret: JWT_SECRET }));
await app.register(
  openapi({ title: "SaaS Demo API", version: "1.0.0", description: "CelsianJS SaaS backend in one file" }),
);

// SSE hub for real-time events
const hub = createSSEHub();

// Auth guard hook
const authGuard = createJWTGuard({ secret: JWT_SECRET });

// ─── Schemas ───

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const UpdateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
});

// ─── Health ───

app.health();

// ─── Auth Endpoints ───

app.post("/register", {
  schema: { body: RegisterSchema },
}, async (req, reply) => {
  const { email, password, name } = req.parsedBody;

  if (emailIndex.has(email)) {
    return reply.conflict("Email already registered");
  }

  const id = String(nextId++);
  const user: User = {
    id,
    email,
    name,
    passwordHash: hashPassword(password),
    role: "user",
    createdAt: new Date().toISOString(),
  };

  users.set(id, user);
  emailIndex.set(email, id);

  // Enqueue welcome email background task
  await app.enqueue("send-welcome-email", { userId: id, email, name });

  // Broadcast new user event via SSE
  hub.broadcast({ event: "user-registered", data: { id, email, name } });

  const jwtNs = app.getDecoration("jwt") as import("@celsian/jwt").JWTNamespace;
  const token = await jwtNs.sign({ sub: id, email, role: "user" }, { expiresIn: "24h" });

  return reply.status(201).json({
    user: { id, email, name, role: user.role },
    token,
  });
});

app.post("/login", {
  schema: { body: LoginSchema },
}, async (req, reply) => {
  const { email, password } = req.parsedBody;

  const userId = emailIndex.get(email);
  if (!userId) {
    return reply.unauthorized("Invalid email or password");
  }

  const user = users.get(userId)!;
  if (user.passwordHash !== hashPassword(password)) {
    return reply.unauthorized("Invalid email or password");
  }

  const jwtNs = app.getDecoration("jwt") as import("@celsian/jwt").JWTNamespace;
  const token = await jwtNs.sign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: "24h" });

  return reply.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// ─── Users CRUD (Protected) ───

app.get("/users", {
  onRequest: authGuard,
}, async (_req, reply) => {
  const list = Array.from(users.values()).map(({ passwordHash: _, ...u }) => u);
  return reply.json({ users: list, total: list.length });
});

app.get("/users/:id", {
  onRequest: authGuard,
}, async (req, reply) => {
  const user = users.get(req.params.id);
  if (!user) return reply.notFound("User not found");
  const { passwordHash: _, ...safe } = user;
  return reply.json(safe);
});

app.put("/users/:id", {
  schema: { body: UpdateUserSchema },
  onRequest: authGuard,
}, async (req, reply) => {
  const user = users.get(req.params.id);
  if (!user) return reply.notFound("User not found");

  const updates = req.parsedBody;
  if (updates.name) user.name = updates.name;
  if (updates.email) {
    if (emailIndex.has(updates.email) && emailIndex.get(updates.email) !== user.id) {
      return reply.conflict("Email already in use");
    }
    emailIndex.delete(user.email);
    user.email = updates.email;
    emailIndex.set(updates.email, user.id);
  }

  const { passwordHash: _, ...safe } = user;
  hub.broadcast({ event: "user-updated", data: safe });
  return reply.json(safe);
});

app.delete("/users/:id", {
  onRequest: authGuard,
}, async (req, reply) => {
  const user = users.get(req.params.id);
  if (!user) return reply.notFound("User not found");

  users.delete(user.id);
  emailIndex.delete(user.email);
  hub.broadcast({ event: "user-deleted", data: { id: user.id } });
  return reply.json({ deleted: true });
});

// ─── Dashboard ───

app.get("/dashboard/stats", {
  onRequest: authGuard,
}, async (_req, reply) => {
  const allUsers = Array.from(users.values());
  const now = Date.now();
  const oneDayAgo = now - 86_400_000;

  return reply.json({
    totalUsers: allUsers.length,
    newUsersToday: allUsers.filter((u) => new Date(u.createdAt).getTime() > oneDayAgo).length,
    adminCount: allUsers.filter((u) => u.role === "admin").length,
    serverUptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ─── SSE Events (Protected) ───

app.get("/events", {
  onRequest: authGuard,
}, async (req, _reply) => {
  const channel = hub.subscribe(req);
  return channel.response;
});

// ─── Background Task: Welcome Email ───

app.task({
  name: "send-welcome-email",
  handler: async ({ input }) => {
    const { userId, email, name } = input as { userId: string; email: string; name: string };
    // Simulate sending an email
    console.log(`[email] Sending welcome email to ${name} <${email}> (user: ${userId})`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(`[email] Welcome email sent to ${email}`);
  },
  retries: 3,
});

// ─── Cron Job: Daily Report ───

app.cron("daily-report", "0 9 * * *", async () => {
  const total = users.size;
  console.log(`[cron] Daily report: ${total} registered users`);
  hub.broadcast({
    event: "daily-report",
    data: { totalUsers: total, generatedAt: new Date().toISOString() },
  });
});

// ─── Start Server ───

app.startWorker();
app.startCron();

serve(app, {
  port: PORT,
  onShutdown: async () => {
    await app.stopWorker();
    app.stopCron();
    console.log("Graceful shutdown complete");
  },
});

console.log(`
  SaaS Demo API running on http://localhost:${PORT}

  Endpoints:
    POST /register         Create account
    POST /login            Get JWT token
    GET  /users            List users (auth required)
    GET  /users/:id        Get user (auth required)
    PUT  /users/:id        Update user (auth required)
    DELETE /users/:id      Delete user (auth required)
    GET  /dashboard/stats  Dashboard (auth required)
    GET  /events           SSE stream (auth required)
    GET  /docs             OpenAPI / Swagger UI
    GET  /health           Health check
`);
