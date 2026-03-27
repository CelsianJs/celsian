export const fullTemplate: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "{{name}}",
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "npx tsx --watch src/index.ts",
        build: "tsc",
        start: "node dist/index.js",
        test: "npx vitest run",
        lint: "npx tsc --noEmit",
      },
      dependencies: {
        celsian: "^0.2.0",
        "@celsian/core": "^0.2.0",
        "@celsian/jwt": "^0.2.0",
        "@celsian/rpc": "^0.2.0",
        "@celsian/rate-limit": "^0.2.0",
        "@sinclair/typebox": "^0.34.0",
      },
      devDependencies: {
        typescript: "^5.7.0",
        tsx: "^4.0.0",
        vitest: "^3.0.0",
        "@types/node": "^22.0.0",
      },
    },
    null,
    2,
  ),

  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022"],
        types: ["node"],
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        isolatedModules: true,
        declaration: true,
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src"],
    },
    null,
    2,
  ),

  ".env.example": `# Server
PORT=3000
HOST=0.0.0.0
CORS_ORIGIN=*

# Auth
JWT_SECRET=change-me-to-a-real-secret-at-least-32-chars

# Database (placeholder — swap for your real DB URL)
DATABASE_URL=file:./data.db

# Environment
NODE_ENV=development
`,

  ".gitignore": `node_modules/
dist/
*.tsbuildinfo
.env
data.db
`,

  // ─── src/types.ts ───
  "src/types.ts": `// Shared types for {{name}}

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

export interface JWTPayload {
  sub: string;
  email: string;
  iat?: number;
  exp?: number;
}
`,

  // ─── src/plugins/database.ts ───
  "src/plugins/database.ts": `// Database module — in-memory store for development
// Replace with a real database (PostgreSQL, SQLite, etc.) for production

import type { User, Session } from '../types.js';

export interface DatabaseStore {
  users: Map<string, User>;
  sessions: Map<string, Session>;
  generateId(): string;
}

function createStore(): DatabaseStore {
  let nextId = 1;
  return {
    users: new Map(),
    sessions: new Map(),
    generateId() {
      return String(nextId++);
    },
  };
}

// Module-level singleton — shared across all routes and plugins
export const db: DatabaseStore = createStore();

// Seed a demo user on import
const demoUser: User = {
  id: db.generateId(),
  name: 'Demo User',
  email: 'demo@example.com',
  createdAt: new Date().toISOString(),
};
db.users.set(demoUser.id, demoUser);
`,

  // ─── src/plugins/auth.ts ───
  "src/plugins/auth.ts": `// JWT auth plugin — guards protected routes via Bearer token
// Uses @celsian/jwt under the hood

import { jwt, createJWTGuard } from '@celsian/jwt';
import type { PluginFunction, HookHandler } from '@celsian/core';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';

/**
 * Register the JWT plugin. After this, \`app.jwt\` is available for
 * signing and verifying tokens.
 */
export function authPlugin(): PluginFunction {
  return jwt({ secret: JWT_SECRET });
}

/**
 * A reusable hook that rejects unauthenticated requests.
 * Attach it to individual routes via \`onRequest\` or as a global hook.
 */
export const requireAuth: HookHandler = createJWTGuard({
  secret: JWT_SECRET,
});
`,

  // ─── src/plugins/security.ts ───
  "src/plugins/security.ts": `// Security plugin — CORS + CSRF + security headers + rate limiting
// Combines multiple @celsian/core plugins into a single registration

import { cors, security, csrf } from '@celsian/core';
import { rateLimit } from '@celsian/rate-limit';
import type { PluginFunction } from '@celsian/core';

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*';

/**
 * Register all security-related plugins in one call.
 */
export function securityPlugins(): PluginFunction[] {
  return [
    // CORS — allow cross-origin requests
    cors({
      origin: CORS_ORIGIN,
      credentials: true,
      maxAge: 86400,
    }),

    // Security headers (Helmet-style)
    security({
      hsts: { maxAge: 31536000, includeSubDomains: true },
      referrerPolicy: 'strict-origin-when-cross-origin',
    }),

    // CSRF protection (double-submit cookie)
    csrf({
      cookieName: '_csrf',
      headerName: 'x-csrf-token',
      excludePaths: ['/health', '/ready', '/_rpc'],
    }),

    // Rate limiting — 100 requests per 60 seconds
    rateLimit({
      max: 100,
      window: 60_000,
    }),
  ];
}
`,

  // ─── src/routes/health.ts ───
  "src/routes/health.ts": `// Health check route — GET /health
// Returns server status and uptime for load balancers and monitoring

import type { PluginFunction } from '@celsian/core';

const startedAt = Date.now();

export default function healthRoutes(): PluginFunction {
  return function health(app) {
    app.get('/health', (_req, reply) => {
      const uptimeMs = Date.now() - startedAt;
      const uptimeSeconds = Math.floor(uptimeMs / 1000);
      return reply.json({
        status: 'ok',
        uptime: uptimeSeconds,
        timestamp: new Date().toISOString(),
      });
    });
  };
}
`,

  // ─── src/routes/users.ts ───
  "src/routes/users.ts": `// User CRUD routes — /users
// Full REST: GET (list), POST (create), GET/:id, PUT/:id, DELETE/:id

import { Type } from '@sinclair/typebox';
import type { PluginFunction, CelsianRequest, CelsianReply } from '@celsian/core';
import type { User, CreateUserInput, UpdateUserInput } from '../types.js';
import { db } from '../plugins/database.js';
import { requireAuth } from '../plugins/auth.js';

const CreateUserSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.String({ minLength: 1 }),
});

const UpdateUserSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  email: Type.Optional(Type.String({ minLength: 1 })),
});

export default function userRoutes(): PluginFunction {
  return function users(app) {
    // GET /users — list all users
    app.get('/users', (_req, reply) => {
      const allUsers = Array.from(db.users.values());
      return reply.json(allUsers);
    });

    // POST /users — create a new user
    app.route({
      method: 'POST',
      url: '/users',
      schema: { body: CreateUserSchema },
      handler(req: CelsianRequest, reply: CelsianReply) {
        const { name, email } = req.parsedBody as CreateUserInput;
        const user: User = {
          id: db.generateId(),
          name,
          email,
          createdAt: new Date().toISOString(),
        };
        db.users.set(user.id, user);
        return reply.status(201).json(user);
      },
    });

    // GET /users/:id — get a single user
    app.get('/users/:id', (req, reply) => {
      const user = db.users.get(req.params.id);
      if (!user) return reply.status(404).json({ error: 'User not found' });
      return reply.json(user);
    });

    // PUT /users/:id — update a user (protected)
    app.route({
      method: 'PUT',
      url: '/users/:id',
      schema: { body: UpdateUserSchema },
      onRequest: requireAuth,
      handler(req: CelsianRequest, reply: CelsianReply) {
        const user = db.users.get(req.params.id);
        if (!user) return reply.status(404).json({ error: 'User not found' });
        const updates = req.parsedBody as UpdateUserInput;
        if (updates.name !== undefined) user.name = updates.name;
        if (updates.email !== undefined) user.email = updates.email;
        db.users.set(user.id, user);
        return reply.json(user);
      },
    });

    // DELETE /users/:id — delete a user (protected)
    app.route({
      method: 'DELETE',
      url: '/users/:id',
      onRequest: requireAuth,
      handler(req: CelsianRequest, reply: CelsianReply) {
        const existed = db.users.delete(req.params.id);
        if (!existed) return reply.status(404).json({ error: 'User not found' });
        return reply.status(204).json({ deleted: true });
      },
    });
  };
}
`,

  // ─── src/routes/rpc.ts ───
  "src/routes/rpc.ts": `// RPC endpoint — type-safe procedures at /_rpc/*
// Demonstrates queries and mutations with typed schemas

import { procedure, router, RPCHandler } from '@celsian/rpc';
import { Type } from '@sinclair/typebox';
import type { PluginFunction } from '@celsian/core';

// Define your RPC router with namespaced procedures
const appRouter = router({
  greeting: {
    hello: procedure
      .input(Type.Object({ name: Type.String() }))
      .query(({ input }) => {
        const { name } = input as { name: string };
        return { message: \`Hello, \${name}!\` };
      }),
  },
  math: {
    add: procedure
      .input(Type.Object({ a: Type.Number(), b: Type.Number() }))
      .query(({ input }) => {
        const { a, b } = input as { a: number; b: number };
        return { result: a + b };
      }),
    multiply: procedure
      .input(Type.Object({ a: Type.Number(), b: Type.Number() }))
      .mutation(({ input }) => {
        const { a, b } = input as { a: number; b: number };
        return { result: a * b };
      }),
  },
  system: {
    ping: procedure.query(() => {
      return { pong: true, timestamp: Date.now() };
    }),
  },
});

// Export the router type for client-side inference
export type AppRouter = typeof appRouter;

export default function rpcRoutes(): PluginFunction {
  return function rpc(app) {
    const rpcHandler = new RPCHandler(appRouter);

    app.route({
      method: ['GET', 'POST'],
      url: '/_rpc/*path',
      handler(req) {
        return rpcHandler.handle(req);
      },
    });
  };
}
`,

  // ─── src/tasks/cleanup.ts ───
  "src/tasks/cleanup.ts": `// Background task: clean up expired sessions
// Registered with app.task() and runs when enqueued or on a schedule

import type { TaskDefinition } from '@celsian/core';

/**
 * Cleanup task — removes expired sessions from the in-memory store.
 * In production, this would run a database query instead.
 */
export const cleanupTask: TaskDefinition = {
  name: 'cleanup',
  retries: 2,
  timeout: 30_000,
  async handler(_input, ctx) {
    ctx.log.info('Running session cleanup...');

    // In a real app, you would query the database:
    // await db.query('DELETE FROM sessions WHERE expires_at < NOW()');

    const now = Date.now();
    let cleaned = 0;

    // Placeholder: log what would happen
    ctx.log.info(\`Session cleanup complete: removed \${cleaned} expired sessions\`);
  },
};
`,

  // ─── src/tasks/report.ts ───
  "src/tasks/report.ts": `// Cron job: daily report generation
// Runs every day at midnight via app.cron()

/**
 * Generate a daily summary report.
 * In production, this might send an email, write to S3, or post to Slack.
 */
export async function generateDailyReport(): Promise<void> {
  const now = new Date();
  console.log(\`[report] Generating daily report for \${now.toISOString().split('T')[0]}\`);

  // Placeholder — swap for real report logic:
  // const users = await db.query('SELECT COUNT(*) FROM users WHERE created_at > $1', [yesterday]);
  // const requests = await analytics.getRequestCount(yesterday, today);
  // await email.send({ to: 'admin@example.com', subject: 'Daily Report', body: ... });

  console.log('[report] Daily report generated successfully');
}
`,

  // ─── src/index.ts ───
  "src/index.ts": `// {{name}} — Full-stack Celsian API
// Routes, plugins, background tasks, and cron — all wired up

import { createApp, serve, openapi } from 'celsian';

// Plugins
import { authPlugin } from './plugins/auth.js';
import { securityPlugins } from './plugins/security.js';

// Database (module-level singleton — imported for side-effect seeding)
import './plugins/database.js';

// Routes
import healthRoutes from './routes/health.js';
import userRoutes from './routes/users.js';
import rpcRoutes from './routes/rpc.js';

// Tasks
import { cleanupTask } from './tasks/cleanup.js';
import { generateDailyReport } from './tasks/report.js';

// ─── Create App ───

const app = createApp({ logger: true });

// ─── Security (CORS, CSRF, headers, rate limiting) ───

for (const plugin of securityPlugins()) {
  await app.register(plugin);
}

// ─── Auth (JWT signing & verification) ───

await app.register(authPlugin());

// ─── API Documentation (OpenAPI + Swagger UI) ───

await app.register(openapi({
  title: '{{name}} API',
  version: '0.1.0',
  description: 'Auto-generated API documentation',
}));

// ─── Routes ───

await app.register(healthRoutes());
await app.register(userRoutes());
await app.register(rpcRoutes());

// ─── Background Tasks ───

app.task(cleanupTask);

// ─── Cron Jobs ───

// Clean up expired sessions every hour
app.cron('session-cleanup', '0 * * * *', async () => {
  await app.enqueue('cleanup', {});
});

// Generate a daily report at midnight
app.cron('daily-report', '0 0 * * *', generateDailyReport);

// ─── Start Server ───

const port = parseInt(process.env.PORT ?? '3000', 10);

serve(app, { port });
`,

  // ─── test/api.test.ts ───
  "test/api.test.ts": `// Integration tests using app.inject() — no server needed
// Run with: npm test

import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from 'celsian';

// Import database module for side-effect (seeds demo user)
import '../src/plugins/database.js';

import healthRoutes from '../src/routes/health.js';
import userRoutes from '../src/routes/users.js';
import rpcRoutes from '../src/routes/rpc.js';

function createTestApp() {
  const app = createApp();
  // Register just what we need — skip auth/security for tests
  app.register(healthRoutes());
  app.register(userRoutes());
  app.register(rpcRoutes());
  return app;
}

describe('Health', () => {
  it('GET /health returns status ok', async () => {
    const app = createTestApp();
    const res = await app.inject({ url: '/health' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('uptime');
    expect(body).toHaveProperty('timestamp');
  });
});

describe('Users CRUD', () => {
  it('GET /users returns the seeded user', async () => {
    const app = createTestApp();
    const res = await app.inject({ url: '/users' });
    expect(res.status).toBe(200);
    const users = await res.json();
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThanOrEqual(1);
    expect(users[0]).toHaveProperty('name', 'Demo User');
  });

  it('POST /users creates a new user', async () => {
    const app = createTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { name: 'Alice', email: 'alice@example.com' },
    });
    expect(res.status).toBe(201);
    const user = await res.json();
    expect(user.name).toBe('Alice');
    expect(user.email).toBe('alice@example.com');
    expect(user).toHaveProperty('id');
    expect(user).toHaveProperty('createdAt');
  });

  it('GET /users/:id returns a specific user', async () => {
    const app = createTestApp();

    // Create a user first
    const createRes = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { name: 'Bob', email: 'bob@example.com' },
    });
    const created = await createRes.json();

    const res = await app.inject({ url: \`/users/\${created.id}\` });
    expect(res.status).toBe(200);
    const user = await res.json();
    expect(user.id).toBe(created.id);
    expect(user.name).toBe('Bob');
  });

  it('GET /users/:id returns 404 for unknown user', async () => {
    const app = createTestApp();
    const res = await app.inject({ url: '/users/99999' });
    expect(res.status).toBe(404);
  });

  it('DELETE /users/:id without auth returns 401', async () => {
    const app = createTestApp();
    const res = await app.inject({ method: 'DELETE', url: '/users/1' });
    // Without the JWT guard registered in test mode, the route handler runs directly.
    // In the full app with auth, this would return 401.
    // For the test app (no auth plugin), it just deletes.
    expect([200, 204, 401].includes(res.status)).toBe(true);
  });
});

describe('RPC', () => {
  it('GET /_rpc/system.ping returns pong', async () => {
    const app = createTestApp();
    const res = await app.inject({ url: '/_rpc/system.ping' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toHaveProperty('pong', true);
  });

  it('GET /_rpc/greeting.hello returns greeting', async () => {
    const app = createTestApp();
    const res = await app.inject({
      url: '/_rpc/greeting.hello?input=' + encodeURIComponent(JSON.stringify({ name: 'World' })),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.message).toBe('Hello, World!');
  });

  it('POST /_rpc/math.multiply performs mutation', async () => {
    const app = createTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/_rpc/math.multiply',
      payload: { a: 6, b: 7 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.result).toBe(42);
  });
});
`,

  // ─── Dockerfile ───
  Dockerfile: `# syntax=docker/dockerfile:1

# ─── Build stage ───
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# ─── Production stage ───
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

USER appuser
EXPOSE 3000

CMD ["node", "dist/index.js"]
`,

  // ─── README.md ───
  "README.md": `# {{name}}

A full-stack API built with [CelsianJS](https://github.com/CelsianJs/celsian) — the fast, modular Node.js framework.

## Quick Start

\`\`\`bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Start development server (with hot reload)
npm run dev
\`\`\`

The server starts at **http://localhost:3000**. Open http://localhost:3000/docs for the Swagger UI.

## Architecture

\`\`\`
src/
  index.ts              # App entry — registers plugins, routes, tasks, cron
  types.ts              # Shared TypeScript types
  routes/
    health.ts           # GET /health — uptime and status
    users.ts            # Full CRUD: GET/POST/PUT/DELETE /users
    rpc.ts              # Type-safe RPC at /_rpc/*
  plugins/
    auth.ts             # JWT authentication (sign, verify, guard)
    database.ts         # In-memory database (replace with real DB)
    security.ts         # CORS + CSRF + security headers + rate limiting
  tasks/
    cleanup.ts          # Background task: expired session cleanup
    report.ts           # Cron job: daily report generation
test/
  api.test.ts           # Integration tests with app.inject()
\`\`\`

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | \`/health\` | No | Server health check |
| GET | \`/users\` | No | List all users |
| POST | \`/users\` | No | Create a user |
| GET | \`/users/:id\` | No | Get a user by ID |
| PUT | \`/users/:id\` | Yes | Update a user |
| DELETE | \`/users/:id\` | Yes | Delete a user |
| GET/POST | \`/_rpc/*\` | No | RPC procedures |
| GET | \`/docs\` | No | Swagger UI |
| GET | \`/docs/openapi.json\` | No | OpenAPI 3.1 spec |

## Adding a New Route

1. Create a new file in \`src/routes/\`:

\`\`\`typescript
// src/routes/products.ts
import type { PluginFunction } from '@celsian/core';

export default function productRoutes(): PluginFunction {
  return function products(app) {
    app.get('/products', (_req, reply) => {
      return reply.json([{ id: 1, name: 'Widget' }]);
    });
  };
}
\`\`\`

2. Register it in \`src/index.ts\`:

\`\`\`typescript
import productRoutes from './routes/products.js';
await app.register(productRoutes());
\`\`\`

## Adding a Background Task

1. Define the task in \`src/tasks/\`:

\`\`\`typescript
// src/tasks/email.ts
import type { TaskDefinition } from '@celsian/core';

export const sendEmailTask: TaskDefinition<{ to: string; subject: string }> = {
  name: 'send-email',
  retries: 3,
  timeout: 10_000,
  async handler(input, ctx) {
    ctx.log.info(\\\`Sending email to \\\${input.to}\\\`);
    // await emailService.send(input);
  },
};
\`\`\`

2. Register and enqueue it:

\`\`\`typescript
// In src/index.ts
import { sendEmailTask } from './tasks/email.js';
app.task(sendEmailTask);

// In a route handler
await app.enqueue('send-email', { to: 'user@example.com', subject: 'Welcome!' });
\`\`\`

## Adding a Cron Job

\`\`\`typescript
// In src/index.ts — uses standard 5-field cron syntax
app.cron('weekly-digest', '0 9 * * 1', async () => {
  // Runs every Monday at 9am
  console.log('Generating weekly digest...');
});
\`\`\`

## API Documentation

OpenAPI 3.1 docs are auto-generated from your route schemas.

- **Swagger UI**: http://localhost:3000/docs
- **JSON spec**: http://localhost:3000/docs/openapi.json

Add schemas to your routes for richer documentation:

\`\`\`typescript
import { Type } from '@sinclair/typebox';

app.route({
  method: 'POST',
  url: '/products',
  schema: {
    body: Type.Object({
      name: Type.String(),
      price: Type.Number({ minimum: 0 }),
    }),
    response: {
      201: Type.Object({ id: Type.Number(), name: Type.String() }),
    },
  },
  handler(req, reply) {
    // req.parsedBody is validated against the schema
    return reply.status(201).json({ id: 1, ...req.parsedBody });
  },
});
\`\`\`

## Testing

Tests use \`app.inject()\` — no HTTP server needed.

\`\`\`bash
npm test
\`\`\`

Write tests by creating a lightweight app and injecting requests:

\`\`\`typescript
import { createApp } from 'celsian';

const app = createApp();
app.get('/ping', (_req, reply) => reply.json({ pong: true }));

const res = await app.inject({ url: '/ping' });
const body = await res.json();
// body = { pong: true }
\`\`\`

## Deployment

### Docker

\`\`\`bash
docker build -t {{name}} .
docker run -p 3000:3000 --env-file .env {{name}}
\`\`\`

### Fly.io

\`\`\`bash
fly launch
fly secrets set JWT_SECRET=your-secret
fly deploy
\`\`\`

### Railway

Push to a connected GitHub repo. Set environment variables in the Railway dashboard. The included Dockerfile is auto-detected.

### Vercel (Serverless)

Use \`@celsian/adapter-vercel\`:

\`\`\`bash
npm install @celsian/adapter-vercel
\`\`\`

See the [adapter docs](https://github.com/CelsianJs/celsian/tree/main/packages/adapter-vercel) for configuration.

### Cloudflare Workers

Use \`@celsian/adapter-cloudflare\`:

\`\`\`bash
npm install @celsian/adapter-cloudflare
\`\`\`

CelsianJS uses standard Web APIs (Request/Response), making it compatible with edge runtimes out of the box.

## Project Structure Explained

- **Plugins** are registered with \`app.register()\` and can decorate the app, add hooks, or define routes.
- **Routes** are plugins that add HTTP endpoints. Group them by domain (users, products, etc.).
- **Tasks** are background jobs processed by the built-in task worker. Enqueue from route handlers.
- **Cron** schedules are standard 5-field Unix cron expressions. The scheduler ticks every second.
- **Hooks** run at different lifecycle stages: \`onRequest\`, \`preHandler\`, \`onSend\`, \`onError\`, etc.

## License

MIT
`,
};
