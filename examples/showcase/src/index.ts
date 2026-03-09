// Pulse — CelsianJS Showcase API
// Demonstrates: hooks, middleware, RPC, SSE, caching, sessions, tasks

import { createApp, cors, rateLimit, jwtAuth, logger } from '@celsian/server';
import { createSSEHub } from '@celsian/server';
import { createTaskQueue, createCronScheduler } from '@celsian/server';
import { MemoryKVStore, createResponseCache, createSessionManager } from '@celsian/cache';
import { procedure, router } from '@celsian/rpc';
import { z } from 'zod';
import { createServer } from 'node:http';

// ─── Data Store ───
interface Task {
  id: string;
  title: string;
  status: 'todo' | 'in-progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  assignee?: string;
  createdAt: number;
  updatedAt: number;
}

const tasks = new Map<string, Task>();
const users = new Map<string, { id: string; email: string; name: string; passwordHash: string }>();

// ─── Infrastructure ───
const app = createApp();
const kvStore = new MemoryKVStore();
const cache = createResponseCache({ store: kvStore, ttlMs: 30_000 });
const sessions = createSessionManager({ store: kvStore });
const hub = createSSEHub();

// Task queue for background notifications
const queue = createTaskQueue({ concurrency: 3, pollIntervalMs: 50 });
queue.register({
  name: 'notify',
  handler: async (job) => {
    console.log(`[notification] ${job.payload.type}: ${job.payload.message}`);
    // In production, send email/push/webhook here
    return { success: true };
  },
  maxRetries: 2,
  retryDelayMs: 1000,
});
queue.start();

// Cron: clean up completed tasks older than 1 hour
const cron = createCronScheduler();
cron.add({
  name: 'cleanup-done-tasks',
  schedule: '5m',
  handler: () => {
    const cutoff = Date.now() - 3600_000;
    let cleaned = 0;
    for (const [id, task] of tasks) {
      if (task.status === 'done' && task.updatedAt < cutoff) {
        tasks.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`[cron] Cleaned ${cleaned} completed tasks`);
  },
});
cron.start();

// ─── Middleware ───
await app.register(logger, { prefix: '[pulse]' });
await app.register(cors, { origin: '*', credentials: true });
await app.register(rateLimit, { max: 200, windowMs: 60_000 });

// ─── REST: Health ───
app.get('/health', (_req, reply) => {
  return reply.json({
    status: 'ok',
    uptime: process.uptime(),
    tasks: tasks.size,
    queueStats: queue.stats(),
  });
});

// ─── REST: Auth ───
const JWT_SECRET = 'pulse-demo-secret-change-in-production';

app.post('/api/auth/register', async (req, reply) => {
  const { email, name, password } = req.parsedBody as any;
  if (!email || !password || !name) {
    return reply.status(400).json({ error: 'email, name, and password required' });
  }
  if (users.has(email)) {
    return reply.status(409).json({ error: 'User already exists' });
  }

  const id = crypto.randomUUID();
  // Simple hash for demo (use bcrypt/scrypt in production)
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'pulse-salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  users.set(email, { id, email, name, passwordHash });
  return reply.status(201).json({ id, email, name });
});

app.post('/api/auth/login', async (req, reply) => {
  const { email, password } = req.parsedBody as any;
  const user = users.get(email);
  if (!user) return reply.status(401).json({ error: 'Invalid credentials' });

  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'pulse-salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (hash !== user.passwordHash) return reply.status(401).json({ error: 'Invalid credentials' });

  // Create session
  const session = await sessions.create({ userId: user.id, email: user.email, name: user.name });
  await session.save();

  return reply
    .header('set-cookie', sessions.cookie(session.id))
    .json({ user: { id: user.id, email, name: user.name }, sessionId: session.id });
});

// ─── REST: Tasks CRUD ───
app.get('/api/tasks', (req, reply) => {
  return cache.cached(req, () => {
    const { status, priority, sort } = req.query;
    let items = Array.from(tasks.values());

    if (status) items = items.filter(t => t.status === status);
    if (priority) items = items.filter(t => t.priority === priority);

    // Sort
    const sortField = sort === 'priority' ? 'priority' : sort === 'title' ? 'title' : 'createdAt';
    items.sort((a, b) => {
      if (sortField === 'priority') {
        const order = { high: 0, medium: 1, low: 2 };
        return order[a.priority] - order[b.priority];
      }
      if (sortField === 'title') return a.title.localeCompare(b.title);
      return b.createdAt - a.createdAt;
    });

    return reply.json({ tasks: items, total: items.length });
  });
});

app.get('/api/tasks/:id', (req, reply) => {
  const task = tasks.get(req.params.id);
  if (!task) return reply.status(404).json({ error: 'Task not found' });
  return reply.json(task);
});

app.post('/api/tasks', async (req, reply) => {
  const { title, priority = 'medium', assignee } = req.parsedBody as any;
  if (!title) return reply.status(400).json({ error: 'title is required' });

  const task: Task = {
    id: crypto.randomUUID(),
    title,
    status: 'todo',
    priority,
    assignee,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  tasks.set(task.id, task);

  // Invalidate cache
  await kvStore.delete('cache:GET:/api/tasks');

  // Broadcast via SSE
  hub.broadcast({ event: 'task:created', data: task });

  // Enqueue notification
  await queue.enqueue('notify', { type: 'task:created', message: `New task: ${title}` });

  return reply.status(201).json(task);
});

app.put('/api/tasks/:id', async (req, reply) => {
  const task = tasks.get(req.params.id);
  if (!task) return reply.status(404).json({ error: 'Task not found' });

  const { title, status, priority, assignee } = req.parsedBody as any;
  if (title) task.title = title;
  if (status) task.status = status;
  if (priority) task.priority = priority;
  if (assignee !== undefined) task.assignee = assignee;
  task.updatedAt = Date.now();

  // Invalidate cache
  await kvStore.delete('cache:GET:/api/tasks');

  // Broadcast
  hub.broadcast({ event: 'task:updated', data: task });

  if (status === 'done') {
    await queue.enqueue('notify', { type: 'task:completed', message: `Completed: ${task.title}` });
  }

  return reply.json(task);
});

app.delete('/api/tasks/:id', async (req, reply) => {
  const task = tasks.get(req.params.id);
  if (!task) return reply.status(404).json({ error: 'Task not found' });

  tasks.delete(req.params.id);
  await kvStore.delete('cache:GET:/api/tasks');
  hub.broadcast({ event: 'task:deleted', data: { id: req.params.id } });

  return reply.status(204).send('');
});

// ─── SSE: Live Updates ───
app.get('/api/events', (req, _reply) => {
  const channel = hub.subscribe(req);
  // Send initial state
  channel.send({ event: 'connected', data: { tasks: tasks.size } });
  return channel.response;
});

// ─── RPC: Type-safe procedures ───
const TaskInput = z.object({
  title: z.string().min(1).max(200),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  assignee: z.string().optional(),
});

const appRouter = router({
  tasks: {
    list: procedure
      .query(() => Array.from(tasks.values())),

    create: procedure
      .input(TaskInput)
      .mutation(async ({ input }) => {
        const task: Task = {
          id: crypto.randomUUID(),
          title: input.title,
          status: 'todo',
          priority: input.priority,
          assignee: input.assignee,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        tasks.set(task.id, task);
        hub.broadcast({ event: 'task:created', data: task });
        return task;
      }),

    complete: procedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => {
        const task = tasks.get(input.id);
        if (!task) throw new Error('Task not found');
        task.status = 'done';
        task.updatedAt = Date.now();
        hub.broadcast({ event: 'task:updated', data: task });
        return task;
      }),

    stats: procedure
      .query(() => {
        const items = Array.from(tasks.values());
        return {
          total: items.length,
          todo: items.filter(t => t.status === 'todo').length,
          inProgress: items.filter(t => t.status === 'in-progress').length,
          done: items.filter(t => t.status === 'done').length,
        };
      }),
  },

  system: {
    health: procedure.query(() => ({
      uptime: process.uptime(),
      memory: process.memoryUsage().heapUsed,
      queue: queue.stats(),
    })),
  },
});

// Mount RPC at /rpc
app.all('/rpc/*', async (req, reply) => {
  // Extract procedure path from URL
  const path = req.url.replace('/rpc/', '').replace(/\//g, '.');
  const body = req.parsedBody as any;

  // Simple RPC dispatch
  const parts = path.split('.');
  let current: any = appRouter;
  for (const part of parts) {
    current = current?.[part];
  }

  if (!current) return reply.status(404).json({ error: 'Procedure not found' });

  try {
    const result = typeof current === 'function'
      ? await current({ input: body })
      : await current;
    return reply.json({ result });
  } catch (err: any) {
    return reply.status(400).json({ error: err.message });
  }
});

// ─── Session info ───
app.get('/api/me', async (req, reply) => {
  const session = await sessions.fromRequest(req);
  const data = session.all();
  if (!data.userId) return reply.status(401).json({ error: 'Not authenticated' });
  return reply.json(data);
});

// ─── Queue stats ───
app.get('/api/queue', (_req, reply) => {
  return reply.json(queue.stats());
});

// ─── Start Server ───
const PORT = parseInt(process.env.PORT || '4000', 10);

// Node.js adapter inline
const server = createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url ?? '/', `http://127.0.0.1:${PORT}`);
  const headers = new Headers();
  for (const [key, val] of Object.entries(nodeReq.headers)) {
    if (val) headers.set(key, Array.isArray(val) ? val.join(', ') : val);
  }

  let body: ReadableStream | null = null;
  if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') {
    body = new ReadableStream({
      start(controller) {
        nodeReq.on('data', (chunk: Buffer) => controller.enqueue(chunk));
        nodeReq.on('end', () => controller.close());
        nodeReq.on('error', (err) => controller.error(err));
      },
    });
  }

  const webReq = new Request(url.toString(), {
    method: nodeReq.method ?? 'GET',
    headers,
    body,
    // @ts-ignore — Node.js 20+ supports duplex
    duplex: body ? 'half' : undefined,
  });

  try {
    const response = await app.handle(webReq);
    nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));

    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { nodeRes.end(); break; }
          nodeRes.write(value);
        }
      };
      pump().catch(() => nodeRes.end());
    } else {
      nodeRes.end();
    }
  } catch {
    nodeRes.writeHead(500);
    nodeRes.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │                                         │
  │   Pulse — CelsianJS Showcase            │
  │   http://localhost:${PORT}                │
  │                                         │
  │   REST:  /api/tasks, /api/auth/*        │
  │   RPC:   /rpc/tasks/*, /rpc/system/*    │
  │   SSE:   /api/events                    │
  │   Queue: /api/queue                     │
  │   Health: /health                       │
  │                                         │
  └─────────────────────────────────────────┘
  `);
});
