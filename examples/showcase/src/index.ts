// Pulse — CelsianJS Showcase API
// Demonstrates: hooks, middleware, RPC, SSE, caching, sessions, tasks

import { createServer } from "node:http";
import { createResponseCache, createSessionManager, MemoryKVStore } from "@celsian/cache";
import { cors, createApp, createSSEHub } from "@celsian/core";
import { procedure, router } from "@celsian/rpc";
import { z } from "zod";

// ─── Data Store ───
interface Task {
  id: string;
  title: string;
  status: "todo" | "in-progress" | "done";
  priority: "low" | "medium" | "high";
  assignee?: string;
  createdAt: number;
  updatedAt: number;
}

const tasks = new Map<string, Task>();
const users = new Map<string, { id: string; email: string; name: string; passwordHash: string }>();

// ─── Infrastructure ───
const app = createApp({ logger: true });
const kvStore = new MemoryKVStore();
const cache = createResponseCache({ store: kvStore, ttlMs: 30_000 });
const sessions = createSessionManager({ store: kvStore });
const hub = createSSEHub();

// Background task: use core's built-in task system
app.task({
  name: "notify",
  handler: async ({ input }) => {
    const payload = input as { type: string; message: string };
    console.log(`[notification] ${payload.type}: ${payload.message}`);
  },
  retries: 2,
});

// Cron: clean up completed tasks older than 1 hour
app.cron("cleanup-done-tasks", "5m", () => {
  const cutoff = Date.now() - 3600_000;
  let cleaned = 0;
  for (const [id, task] of tasks) {
    if (task.status === "done" && task.updatedAt < cutoff) {
      tasks.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[cron] Cleaned ${cleaned} completed tasks`);
});

// ─── Middleware ───
await app.register(cors({ origin: "*", credentials: true }), { encapsulate: false });

// ─── REST: Health ───
app.health();

// ─── REST: Auth ───
const _JWT_SECRET =
  process.env.JWT_SECRET ??
  (() => {
    throw new Error("Set JWT_SECRET env var");
  })();
const PASSWORD_SALT =
  process.env.PASSWORD_SALT ??
  (() => {
    throw new Error("Set PASSWORD_SALT env var");
  })();

const RegisterSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(1),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

app.post("/api/auth/register", {
  schema: { body: RegisterSchema },
}, async (req, reply) => {
  const { email, name, password } = req.parsedBody;
  if (users.has(email)) {
    return reply.status(409).json({ error: "User already exists" });
  }

  const id = crypto.randomUUID();
  // Simple hash for demo -- use bcrypt or argon2 in production
  const encoder = new TextEncoder();
  const data = encoder.encode(password + PASSWORD_SALT);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const passwordHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  users.set(email, { id, email, name, passwordHash });
  return reply.status(201).json({ id, email, name });
});

app.post("/api/auth/login", {
  schema: { body: LoginSchema },
}, async (req, reply) => {
  const { email, password } = req.parsedBody;
  const user = users.get(email);
  if (!user) return reply.status(401).json({ error: "Invalid credentials" });

  // Simple hash for demo -- use bcrypt or argon2 in production
  const encoder = new TextEncoder();
  const data = encoder.encode(password + PASSWORD_SALT);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (hash !== user.passwordHash) return reply.status(401).json({ error: "Invalid credentials" });

  const session = await sessions.create({ userId: user.id, email: user.email, name: user.name });
  await session.save();

  return reply
    .header("set-cookie", sessions.cookie(session.id))
    .json({ user: { id: user.id, email, name: user.name }, sessionId: session.id });
});

// ─── REST: Tasks CRUD ───
app.get("/api/tasks", (req, reply) => {
  return cache.cached(req, () => {
    const { status, priority, sort } = req.query;
    let items = Array.from(tasks.values());

    if (status) items = items.filter((t) => t.status === status);
    if (priority) items = items.filter((t) => t.priority === priority);

    const sortField = sort === "priority" ? "priority" : sort === "title" ? "title" : "createdAt";
    items.sort((a, b) => {
      if (sortField === "priority") {
        const order = { high: 0, medium: 1, low: 2 };
        return order[a.priority] - order[b.priority];
      }
      if (sortField === "title") return a.title.localeCompare(b.title);
      return b.createdAt - a.createdAt;
    });

    return reply.json({ tasks: items, total: items.length });
  });
});

app.get("/api/tasks/:id", (req, reply) => {
  const task = tasks.get(req.params.id);
  if (!task) return reply.status(404).json({ error: "Task not found" });
  return reply.json(task);
});

const CreateTaskSchema = z.object({
  title: z.string().min(1, "title is required"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  assignee: z.string().optional(),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(["todo", "in-progress", "done"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  assignee: z.string().optional(),
});

app.post("/api/tasks", {
  schema: { body: CreateTaskSchema },
}, async (req, reply) => {
  const { title, priority, assignee } = req.parsedBody;

  const task: Task = {
    id: crypto.randomUUID(),
    title,
    status: "todo",
    priority,
    assignee,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  tasks.set(task.id, task);

  await kvStore.delete("cache:GET:/api/tasks");
  hub.broadcast({ event: "task:created", data: task });
  await app.enqueue("notify", { type: "task:created", message: `New task: ${title}` });

  return reply.status(201).json(task);
});

app.put("/api/tasks/:id", {
  schema: { body: UpdateTaskSchema },
}, async (req, reply) => {
  const task = tasks.get(req.params.id);
  if (!task) return reply.status(404).json({ error: "Task not found" });

  const { title, status, priority, assignee } = req.parsedBody;
  if (title) task.title = title;
  if (status) task.status = status;
  if (priority) task.priority = priority;
  if (assignee !== undefined) task.assignee = assignee;
  task.updatedAt = Date.now();

  await kvStore.delete("cache:GET:/api/tasks");
  hub.broadcast({ event: "task:updated", data: task });

  if (status === "done") {
    await app.enqueue("notify", { type: "task:completed", message: `Completed: ${task.title}` });
  }

  return reply.json(task);
});

app.delete("/api/tasks/:id", async (req, reply) => {
  const task = tasks.get(req.params.id);
  if (!task) return reply.status(404).json({ error: "Task not found" });

  tasks.delete(req.params.id);
  await kvStore.delete("cache:GET:/api/tasks");
  hub.broadcast({ event: "task:deleted", data: { id: req.params.id } });

  return reply.status(204).send("");
});

// ─── SSE: Live Updates ───
app.get("/api/events", (req, _reply) => {
  const channel = hub.subscribe(req);
  channel.send({ event: "connected", data: { tasks: tasks.size } });
  return channel.response;
});

// ─── RPC: Type-safe procedures ───
const TaskInput = z.object({
  title: z.string().min(1).max(200),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  assignee: z.string().optional(),
});

const _appRouter = router({
  tasks: {
    list: procedure.query(() => Array.from(tasks.values())),

    create: procedure.input(TaskInput).mutation(async ({ input }) => {
      const task: Task = {
        id: crypto.randomUUID(),
        title: input.title,
        status: "todo",
        priority: input.priority,
        assignee: input.assignee,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.set(task.id, task);
      hub.broadcast({ event: "task:created", data: task });
      return task;
    }),

    complete: procedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
      const task = tasks.get(input.id);
      if (!task) throw new Error("Task not found");
      task.status = "done";
      task.updatedAt = Date.now();
      hub.broadcast({ event: "task:updated", data: task });
      return task;
    }),

    stats: procedure.query(() => {
      const items = Array.from(tasks.values());
      return {
        total: items.length,
        todo: items.filter((t) => t.status === "todo").length,
        inProgress: items.filter((t) => t.status === "in-progress").length,
        done: items.filter((t) => t.status === "done").length,
      };
    }),
  },

  system: {
    health: procedure.query(() => ({
      uptime: process.uptime(),
      memory: process.memoryUsage().heapUsed,
    })),
  },
});

// ─── Session info ───
app.get("/api/me", async (req, reply) => {
  const session = await sessions.fromRequest(req);
  const data = session.all();
  if (!data.userId) return reply.status(401).json({ error: "Not authenticated" });
  return reply.json(data);
});

// ─── Start Server ───
const PORT = parseInt(process.env.PORT || "4000", 10);

const server = createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url ?? "/", `http://127.0.0.1:${PORT}`);
  const headers = new Headers();
  for (const [key, val] of Object.entries(nodeReq.headers)) {
    if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
  }

  let body: ReadableStream | null = null;
  if (nodeReq.method !== "GET" && nodeReq.method !== "HEAD") {
    body = new ReadableStream({
      start(controller) {
        nodeReq.on("data", (chunk: Buffer) => controller.enqueue(chunk));
        nodeReq.on("end", () => controller.close());
        nodeReq.on("error", (err) => controller.error(err));
      },
    });
  }

  const webReq = new Request(url.toString(), {
    method: nodeReq.method ?? "GET",
    headers,
    body,
    // @ts-expect-error — Node.js 20+ supports duplex
    duplex: body ? "half" : undefined,
  });

  try {
    const response = await app.handle(webReq);
    nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));

    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            nodeRes.end();
            break;
          }
          nodeRes.write(value);
        }
      };
      pump().catch(() => nodeRes.end());
    } else {
      nodeRes.end();
    }
  } catch {
    nodeRes.writeHead(500);
    nodeRes.end("Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`
  Pulse — CelsianJS Showcase
  http://localhost:${PORT}

  REST:  /api/tasks, /api/auth/*
  SSE:   /api/events
  Health: /health
  `);
});
