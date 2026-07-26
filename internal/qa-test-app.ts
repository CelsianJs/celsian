// CelsianJS QA Test App — exercises every feature
// NOTE: This version uses serve() which is broken in ESM (BUG-1).
// See examples/qa-test/src/index.ts for the working version with manual HTTP server.

import { compress } from "@celsian/compress";
import { cors, createApp, HttpError, serve } from "@celsian/core";
import { createJWTGuard, jwt } from "@celsian/jwt";
import { rateLimit } from "@celsian/rate-limit";
import { procedure, RPCHandler, router } from "@celsian/rpc";
import { Type } from "@sinclair/typebox";

const app = createApp({ logger: true });

// ─── Plugins ───

// CORS
await app.register(
  cors({
    origin: ["http://localhost:3000", "http://example.com"],
    credentials: true,
    maxAge: 3600,
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["X-Custom-Header"],
  }),
  { encapsulate: false },
);

// JWT
await app.register(jwt({ secret: "qa-test-secret-key-32chars!!!" }), { encapsulate: false });

// Rate limiting (high limit for testing, but low enough to hit)
await app.register(
  rateLimit({
    max: 50,
    window: 60_000,
    keyGenerator: (req) => req.headers.get("x-forwarded-for") ?? req.headers.get("x-test-client") ?? "unknown",
  }),
  { encapsulate: false },
);

// Compression
await app.register(compress({ threshold: 256 }), { encapsulate: false });

// ─── Track hook execution for verification ───
const hookLog: string[] = [];

app.addHook("onRequest", (_req, _reply) => {
  hookLog.push("onRequest");
});

app.addHook("preParsing", (_req, _reply) => {
  hookLog.push("preParsing");
});

app.addHook("preValidation", (_req, _reply) => {
  hookLog.push("preValidation");
});

app.addHook("preHandler", (_req, _reply) => {
  hookLog.push("preHandler");
});

app.addHook("preSerialization", (_req, _reply) => {
  hookLog.push("preSerialization");
});

app.addHook("onSend", (_req, _reply) => {
  hookLog.push("onSend");
});

app.addHook("onResponse", (_req, _reply) => {
  hookLog.push("onResponse");
});

app.addHook("onError", (_error, _req, _reply) => {
  hookLog.push("onError");
  // Let default error handling proceed
});

// ─── Routes ───

// 1. Health check
app.get("/api/health", (_req, reply) => {
  return reply.json({
    status: "ok",
    framework: "celsian",
    timestamp: new Date().toISOString(),
  });
});

// 2. Route params
app.get("/api/hello/:name", (req, reply) => {
  return reply.json({ message: `Hello, ${req.params.name}!` });
});

// 3. Nested route params
app.get("/api/users/:userId/posts/:postId", (req, reply) => {
  return reply.json({
    userId: req.params.userId,
    postId: req.params.postId,
  });
});

// 4. Query strings
app.get("/api/search", (req, reply) => {
  return reply.json({
    query: req.query,
  });
});

// 5. POST with JSON body parsing
app.post("/api/echo", (req, reply) => {
  return reply.json({ received: req.parsedBody });
});

// 6. Schema validation (TypeBox)
const CreateUserSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.String(),
  age: Type.Optional(Type.Number({ minimum: 0 })),
});

app.route({
  method: "POST",
  url: "/api/users",
  schema: { body: CreateUserSchema },
  handler(req, reply) {
    const body = req.parsedBody as { name: string; email: string; age?: number };
    return reply.status(201).json({ id: 1, ...body });
  },
});

// 7. Cookie handling
app.get("/api/cookies/set", (_req, reply) => {
  reply.cookie("session", "abc123", {
    httpOnly: true,
    secure: true,
    path: "/",
    maxAge: 3600,
    sameSite: "lax",
  });
  reply.cookie("theme", "dark", { path: "/" });
  return reply.json({ message: "Cookies set" });
});

app.get("/api/cookies/read", (req, reply) => {
  return reply.json({ cookies: (req as any).cookies });
});

app.get("/api/cookies/clear", (_req, reply) => {
  reply.clearCookie("session", { path: "/" });
  return reply.json({ message: "Cookie cleared" });
});

// 8. JWT sign and verify
app.post("/api/auth/login", async (req, reply) => {
  const body = req.parsedBody as { username: string } | undefined;
  const jwtInstance = (app as any).jwt;
  if (!jwtInstance) {
    return reply.status(500).json({ error: "JWT not configured" });
  }
  const token = await jwtInstance.sign({ sub: body?.username ?? "anonymous", role: "user" }, { expiresIn: "1h" });
  return reply.json({ token });
});

// Protected route with JWT guard
const jwtGuard = createJWTGuard({ secret: "qa-test-secret-key-32chars!!!" });
app.route({
  method: "GET",
  url: "/api/auth/me",
  preHandler: jwtGuard,
  handler(req, reply) {
    return reply.json({ user: (req as any).user });
  },
});

// 9. HTML response
app.get("/api/html", (_req, reply) => {
  return reply.html("<html><body><h1>Hello from Celsian</h1></body></html>");
});

// 10. Redirect
app.get("/api/redirect", (_req, reply) => {
  return reply.redirect("/api/health", 302);
});

// 11. Streaming response
app.get("/api/stream", (_req, reply) => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("chunk1\n"));
      controller.enqueue(new TextEncoder().encode("chunk2\n"));
      controller.enqueue(new TextEncoder().encode("chunk3\n"));
      controller.close();
    },
  });
  return reply.stream(stream);
});

// 12. Binary response
app.get("/api/binary", (_req, _reply) => {
  const buffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Response(buffer, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
});

// 13. Handler that throws
app.get("/api/throw", () => {
  throw new Error("Intentional test error");
});

app.get("/api/throw/http", () => {
  throw new HttpError(422, "Validation failed on purpose");
});

// 14. Status codes
app.get("/api/status/:code", (req, reply) => {
  const code = parseInt(req.params.code, 10);
  return reply.status(code).json({ statusCode: code });
});

// 15. Large response (for compression testing)
app.get("/api/large", (_req, reply) => {
  const data = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    name: `Item ${i}`,
    description: `This is a fairly long description for item number ${i} to ensure the response body is large enough to trigger compression.`,
  }));
  return reply.json(data);
});

// 16. Hook log reader
app.get("/api/hooks/log", (_req, reply) => {
  const log = [...hookLog];
  hookLog.length = 0; // Reset
  return reply.json({ hooks: log });
});

// 17. All registered routes
app.get("/api/routes", (_req, reply) => {
  const routes = app.getRoutes().map((r) => ({ method: r.method, url: r.url, kind: r.kind }));
  return reply.json({ routes, count: routes.length });
});

// 18. Background tasks
let taskResults: string[] = [];

app.task({
  name: "send-email",
  handler: async (input: { to: string; subject: string }, ctx) => {
    ctx.log.info("Processing email task", { to: input.to, subject: input.subject });
    taskResults.push(`Email sent to ${input.to}: ${input.subject}`);
  },
  retries: 2,
  timeout: 5000,
});

app.post("/api/tasks/enqueue", async (req, reply) => {
  const body = req.parsedBody as { to: string; subject: string };
  const taskId = await app.enqueue("send-email", body);
  return reply.status(202).json({ taskId, message: "Task enqueued" });
});

app.get("/api/tasks/results", (_req, reply) => {
  const results = [...taskResults];
  taskResults = [];
  return reply.json({ results });
});

// 19. Cron scheduling
let cronTicks = 0;
app.cron("tick-counter", "* * * * *", () => {
  cronTicks++;
});

app.get("/api/cron/status", (_req, reply) => {
  const jobs = app.getCronJobs();
  return reply.json({
    jobs: jobs.map((j) => ({ name: j.name, schedule: j.schedule })),
    ticks: cronTicks,
  });
});

// 20. RPC procedures
const appRouter = router({
  greeting: {
    hello: procedure.input(Type.Object({ name: Type.String() })).query(({ input }) => {
      return { message: `Hello, ${(input as any).name}!` };
    }),
  },
  math: {
    add: procedure.input(Type.Object({ a: Type.Number(), b: Type.Number() })).mutation(({ input }) => {
      return { result: (input as any).a + (input as any).b };
    }),
  },
});

const rpcHandler = new RPCHandler(appRouter);

app.route({
  method: ["GET", "POST"],
  url: "/_rpc/*path",
  handler(req) {
    return rpcHandler.handle(req);
  },
});

// 21. Custom error handling route
app.addHook("onError", (error, _req, reply) => {
  if (error.message === "Custom handled error") {
    return reply.status(418).json({ error: "I am a teapot", custom: true });
  }
});

app.get("/api/custom-error", () => {
  throw Object.assign(new Error("Custom handled error"), {});
});

// 22. PUT and DELETE methods
app.put("/api/items/:id", (req, reply) => {
  return reply.json({ updated: req.params.id, body: req.parsedBody });
});

app.delete("/api/items/:id", (req, reply) => {
  return reply.json({ deleted: req.params.id });
});

app.patch("/api/items/:id", (req, reply) => {
  return reply.json({ patched: req.params.id, body: req.parsedBody });
});

// 23. Reply chaining
app.get("/api/chained", (_req, reply) => {
  return reply
    .status(200)
    .header("x-custom-header", "test-value")
    .header("x-another", "another-value")
    .json({ chained: true });
});

// ─── Start Server ───

const controller = new AbortController();
let _shutdownCalled = false;

serve(app, {
  port: 3456,
  signal: controller.signal,
  shutdownTimeout: 5_000,
  onReady: ({ port, host }) => {
    console.log(`[QA] Test server ready on http://${host}:${port}`);
  },
  onShutdown: async () => {
    _shutdownCalled = true;
    console.log("[QA] Shutdown hook called");
  },
});
