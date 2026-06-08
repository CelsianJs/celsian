// Comprehensive CelsianJS demo app exercising every framework feature.
// Used for realism audit: inject-based tests + live server deployment.

import { z } from "zod";
import { createApp, type CelsianRequest, type CelsianReply } from "../packages/core/src/app.js";
import { HttpError } from "../packages/core/src/errors.js";
import { cors } from "../packages/core/src/plugins/cors.js";
import { csrf } from "../packages/core/src/plugins/csrf.js";
import { security } from "../packages/core/src/plugins/security.js";
import { openapi } from "../packages/core/src/plugins/openapi.js";
import { upload } from "../packages/core/src/plugins/upload.js";
import { withETag } from "../packages/core/src/plugins/etag.js";
import { createSSEStream } from "../packages/core/src/sse.js";
import { accepts, acceptsEncoding, acceptsLanguage } from "../packages/core/src/negotiate.js";
import { compress } from "../packages/compress/src/index.js";
import { rateLimit } from "../packages/rate-limit/src/index.js";
import { createResponseCache, createSessionManager, MemoryKVStore } from "../packages/cache/src/index.js";
import { jwt, createJWTGuard } from "../packages/jwt/src/index.js";
import { procedure, RPCHandler, router } from "../packages/rpc/src/index.js";
import { fromZod } from "../packages/schema/src/index.js";

// ─── In-memory data store ───

const users = new Map<string, { id: string; name: string; email: string }>();
const items = new Map<string, { id: string; title: string; done: boolean; ownerId: string }>();
let itemCounter = 0;

// ─── Build the app ───

export function buildApp() {
  const app = createApp({ logger: false, prefix: "/api" });

  // --- Global plugins ---
  app.register(security({ hsts: false }), { encapsulate: false });
  app.register(cors({ origin: "*" }), { encapsulate: false });
  app.register(compress({ threshold: 64 }), { encapsulate: false });
  app.register(jwt({ secret: "realism-audit-secret-key-32chars!" }), { encapsulate: false });

  // --- OpenAPI docs ---
  app.register(openapi({
    title: "CelsianJS Realism Audit",
    version: "1.0.0",
    description: "Comprehensive feature exercise",
  }), { encapsulate: false });

  // --- Health check (built-in helper) ---
  app.health({ path: "/health", readyPath: "/ready" });

  // --- KV store & sessions ---
  const kvStore = new MemoryKVStore({ cleanupIntervalMs: 0 });
  const sessions = createSessionManager({ store: kvStore, ttlMs: 3600_000 });
  const cache = createResponseCache({ store: kvStore, ttlMs: 60_000 });

  // --- Rate-limited zone ---
  app.register(async (rateLimited) => {
    rateLimited.register(rateLimit({
      max: 100,
      windowMs: 60_000,
      keyGenerator: (req) => req.headers.get("x-forwarded-for") ?? "127.0.0.1",
    }), { encapsulate: false });

    // --- Auth routes ---
    rateLimited.post("/auth/register", async (req, reply) => {
      const body = req.parsedBody as { name: string; email: string; password: string };
      if (!body.name || !body.email) {
        return reply.badRequest("name and email required");
      }
      const id = `user-${Date.now()}`;
      users.set(id, { id, name: body.name, email: body.email });
      const token = await (app as any).jwt.sign({ sub: id, name: body.name });
      return reply.status(201).json({ user: { id, name: body.name, email: body.email }, token });
    });

    rateLimited.post("/auth/login", async (req, reply) => {
      const body = req.parsedBody as { email: string; password: string };
      const user = [...users.values()].find(u => u.email === body.email);
      if (!user) return reply.unauthorized("invalid credentials");
      const token = await (app as any).jwt.sign({ sub: user.id, name: user.name });
      return reply.json({ token });
    });
  }, { prefix: "" });

  // --- Protected CRUD routes ---
  const jwtGuard = createJWTGuard();

  app.get("/items", async (req, reply) => {
    const allItems = [...items.values()];
    return reply.json({ items: allItems, count: allItems.length });
  });

  app.post("/items", { onRequest: [jwtGuard] } as any, async (req: any, reply) => {
    const body = req.parsedBody as { title: string };
    if (!body.title) return reply.badRequest("title required");
    const id = `item-${++itemCounter}`;
    const item = { id, title: body.title, done: false, ownerId: req.user?.sub ?? "anonymous" };
    items.set(id, item);
    return reply.status(201).json(item);
  });

  app.get("/items/:id", async (req, reply) => {
    const item = items.get(req.params.id);
    if (!item) return reply.notFound("item not found");
    return reply.json(item);
  });

  app.put("/items/:id", { onRequest: [jwtGuard] } as any, async (req: any, reply) => {
    const item = items.get(req.params.id);
    if (!item) return reply.notFound("item not found");
    const body = req.parsedBody as { title?: string; done?: boolean };
    if (body.title !== undefined) item.title = body.title;
    if (body.done !== undefined) item.done = body.done;
    return reply.json(item);
  });

  app.delete("/items/:id", { onRequest: [jwtGuard] } as any, async (req: any, reply) => {
    if (!items.has(req.params.id)) return reply.notFound("item not found");
    items.delete(req.params.id);
    return reply.status(204).send(null);
  });

  // --- Schema-validated route (Zod) ---
  const CreateItemSchema = z.object({
    title: z.string().min(1).max(200),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
  });

  app.post("/items/validated", {
    schema: { body: CreateItemSchema },
    onRequest: [jwtGuard],
  }, async (req: any, reply) => {
    const { title, priority } = req.parsedBody;
    const id = `item-${++itemCounter}`;
    const item = { id, title, done: false, priority, ownerId: req.user?.sub ?? "anonymous" };
    items.set(id, item);
    return reply.status(201).json(item);
  });

  // --- ETag conditional responses ---
  app.get("/etag-demo", (req) => {
    const data = { message: "this response supports conditional requests", version: 1 };
    return withETag(req, data);
  });

  // --- SSE endpoint ---
  app.get("/events", (req) => {
    const channel = createSSEStream(req, {
      pingInterval: 5000,
      onClose: () => {},
    });
    channel.send({ event: "connected", data: { ts: Date.now() } });
    let count = 0;
    const interval = setInterval(() => {
      count++;
      channel.send({ event: "tick", data: { count }, id: String(count) });
      if (count >= 3) {
        clearInterval(interval);
        channel.close();
      }
    }, 100);
    return channel.response;
  });

  // --- Content negotiation ---
  app.get("/negotiate", (req, reply) => {
    const type = accepts(req, ["application/json", "text/html", "text/plain"]);
    const encoding = acceptsEncoding(req, ["gzip", "deflate", "identity"]);
    const lang = acceptsLanguage(req, ["en-US", "fr", "es"]);
    return reply.json({ preferredType: type, preferredEncoding: encoding, preferredLang: lang });
  });

  // --- Cookie lifecycle ---
  app.get("/cookie/set", (_req, reply) => {
    return reply
      .cookie("session", "abc123", { httpOnly: true, path: "/", maxAge: 3600 })
      .cookie("theme", "dark", { path: "/" })
      .json({ set: true });
  });

  app.get("/cookie/read", (req, reply) => {
    return reply.json({ cookies: req.cookies });
  });

  app.get("/cookie/clear", (_req, reply) => {
    return reply.clearCookie("session", { path: "/" }).json({ cleared: true });
  });

  // --- Reply helpers ---
  app.get("/reply/html", (_req, reply) => {
    return reply.html("<h1>Hello from CelsianJS</h1>");
  });

  app.get("/reply/redirect", (_req, reply) => {
    return reply.redirect("/api/health");
  });

  app.get("/reply/stream", (_req, reply) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk1"));
        controller.enqueue(new TextEncoder().encode("chunk2"));
        controller.close();
      },
    });
    return reply.stream(stream);
  });

  // --- Error handling ---
  app.get("/error/http", () => {
    throw new HttpError(422, "Validation failed", { code: "CUSTOM_VALIDATION" });
  });

  app.get("/error/unexpected", () => {
    throw new Error("unexpected boom");
  });

  app.get("/error/not-found", (_req, reply) => {
    return reply.notFound("custom not found message");
  });

  // --- Custom 404 handler ---
  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).json({ error: "Route not found", hint: "Check /api/docs for available endpoints" });
  });

  // --- Upload plugin (registers as preHandler hook, populates req.files/req.fields) ---
  app.register(upload({ maxFileSize: 1_048_576, maxFiles: 3 }), { encapsulate: false });

  app.post("/upload", async (req, reply) => {
    const files = (req as any).files as Array<{ fieldName: string; fileName: string; mimeType: string; size: number }>;
    const fields = (req as any).fields as Record<string, string>;
    return reply.json({ uploaded: files.map(f => ({ name: f.fileName, size: f.size, type: f.mimeType })), fields });
  });

  // --- Session management ---
  app.post("/session/create", async (req, reply) => {
    const body = req.parsedBody as { username: string };
    const session = await sessions.create({ username: body.username, createdAt: Date.now() });
    await session.save();
    return reply.json({ sessionId: session.id });
  });

  app.get("/session/:id", async (req, reply) => {
    const session = await sessions.load(req.params.id);
    if (!session) return reply.notFound("session not found");
    return reply.json({ session: session.all() });
  });

  app.delete("/session/:id", async (req, reply) => {
    const session = await sessions.load(req.params.id);
    if (session) await session.destroy();
    return reply.json({ destroyed: true });
  });

  // --- Response cache ---
  app.get("/cached", async (req, reply) => {
    const response = await cache.cached(req, async () => {
      const data = { ts: Date.now(), value: Math.random() };
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    });
    return response;
  });

  // --- Background tasks ---
  const taskResults: string[] = [];
  app.task({
    name: "audit-task",
    handler: async (input: { message: string }) => {
      taskResults.push(input.message);
    },
    retries: 2,
  });

  app.post("/tasks/enqueue", async (req, reply) => {
    const body = req.parsedBody as { message: string };
    const taskId = await app.enqueue("audit-task", { message: body.message });
    return reply.json({ taskId });
  });

  app.get("/tasks/results", (_req, reply) => {
    return reply.json({ results: taskResults });
  });

  // --- Cron job (demo registration) ---
  let cronTicks = 0;
  app.cron("audit-cron", "* * * * *", () => {
    cronTicks++;
  });

  app.get("/cron/status", (_req, reply) => {
    return reply.json({ ticks: cronTicks, registered: app.getCronJobs().length });
  });

  // --- Decorations ---
  app.decorate("version", "1.0.0-audit");
  app.decorateRequest("startTime", 0);

  app.addHook("onRequest", async (req) => {
    (req as any).startTime = Date.now();
  });

  app.get("/meta", (req, reply) => {
    return reply.json({
      version: (app as any).version,
      startTime: (req as any).startTime,
    });
  });

  // --- Lifecycle hooks demo ---
  const hookLog: string[] = [];

  app.addHook("onRequest", async () => { hookLog.push("onRequest"); });
  app.addHook("preHandler", async () => { hookLog.push("preHandler"); });
  app.addHook("onSend", async () => { hookLog.push("onSend"); });
  app.addHook("onResponse", async () => { hookLog.push("onResponse"); });

  app.get("/hooks/trace", (_req, reply) => {
    hookLog.push("handler");
    return reply.json({ trace: [...hookLog] });
  });

  app.get("/hooks/reset", (_req, reply) => {
    hookLog.length = 0;
    return reply.json({ reset: true });
  });

  // --- WebSocket registration ---
  app.ws("/ws/echo", {
    open(ws) { ws.send("connected"); },
    message(ws, data) { ws.send(typeof data === "string" ? data : "binary"); },
    close() {},
  });

  app.ws("/ws/chat", {
    open(ws) {
      ws.metadata.joined = Date.now();
      ws.send(JSON.stringify({ type: "welcome" }));
    },
    message(ws, data) {
      app.wsBroadcast("/ws/chat", typeof data === "string" ? data : "binary", ws.id);
    },
    close() {},
  });

  // --- RPC setup ---
  const rpcRoutes = router({
    greeting: {
      hello: procedure
        .input(z.object({ name: z.string() }))
        .query(({ input }) => ({ message: `Hello, ${input.name}!` })),
    },
    math: {
      add: procedure
        .input(z.object({ a: z.number(), b: z.number() }))
        .query(({ input }) => ({ result: input.a + input.b })),
      multiply: procedure
        .input(z.object({ a: z.number(), b: z.number() }))
        .mutation(({ input }) => ({ result: input.a * input.b })),
    },
  });

  const rpcHandler = new RPCHandler(rpcRoutes, { basePath: "/api/_rpc" });

  app.get("/_rpc/*path", async (req) => {
    return rpcHandler.handle(req);
  });

  app.post("/_rpc/*path", async (req) => {
    return rpcHandler.handle(req);
  });

  // --- Route manifest ---
  app.get("/routes", (_req, reply) => {
    return reply.json({ routes: app.getRoutes() });
  });

  return { app, taskResults, users, items, kvStore };
}
