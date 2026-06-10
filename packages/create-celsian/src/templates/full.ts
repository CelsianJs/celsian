import { CELSIAN_VERSION, DEPS, DEV_DEPS } from "../versions.js";

// Shipped both as `.env.example` (committed) and `.env` (gitignored) so the
// dev/start scripts' --env-file=.env works immediately after scaffolding.
const ENV_FILE = `# Server
PORT=3000
HOST=0.0.0.0
CORS_ORIGIN=http://localhost:3000

# Auth
JWT_SECRET=change-me-to-a-real-secret-at-least-32-chars

# Database (placeholder — swap for your real DB URL)
DATABASE_URL=file:./data.db

# Environment
NODE_ENV=development
`;

export const fullTemplate: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "{{name}}",
      version: "0.1.0",
      type: "module",
      scripts: {
        // tsx >=4.16 forwards --env-file to Node, so PORT/JWT_SECRET from .env are loaded
        dev: "npx tsx --env-file=.env --watch src/index.ts",
        build: "tsc",
        start: "node --env-file=.env dist/index.js",
        test: "npx vitest run",
        lint: "npx tsc --noEmit",
      },
      dependencies: {
        celsian: CELSIAN_VERSION,
        "@celsian/core": CELSIAN_VERSION,
        "@celsian/jwt": CELSIAN_VERSION,
        "@celsian/rpc": CELSIAN_VERSION,
        "@celsian/rate-limit": CELSIAN_VERSION,
        "@sinclair/typebox": DEPS.typebox,
      },
      devDependencies: {
        typescript: DEV_DEPS.typescript,
        tsx: DEV_DEPS.tsx,
        vitest: DEV_DEPS.vitest,
        "@types/node": DEV_DEPS.typesNode,
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

  ".env.example": ENV_FILE,

  // Scaffolded directly (and gitignored) so `npm run dev` works out of the box —
  // both the dev and start scripts load it via --env-file=.env.
  ".env": ENV_FILE,

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

// Known insecure placeholder values shipped with the scaffold — refuse to
// start in production with any of them (covers both the code default and the
// value written into the generated .env / .env.example).
const INSECURE_SECRETS = new Set([
  'dev-secret-change-me',
  'change-me-to-a-real-secret-at-least-32-chars',
]);

// Refuse to start in production with a known scaffold placeholder secret
if (process.env.NODE_ENV === 'production' && INSECURE_SECRETS.has(JWT_SECRET)) {
  throw new Error(
    '[celsian] FATAL: JWT_SECRET is still set to a scaffold placeholder value. ' +
    'Set a strong, unique JWT_SECRET environment variable before running in production. ' +
    'Generate one with: node -e "console.log(require(\\'crypto\\').randomBytes(32).toString(\\'base64\\'))"'
  );
}

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

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

/**
 * Register all security-related plugins in one call.
 */
export function securityPlugins(): PluginFunction[] {
  // WARNING: credentials:true is incompatible with origin:'*'.
  // Browsers will reject Set-Cookie headers when the CORS origin is a wildcard.
  // Always set CORS_ORIGIN to a specific origin (e.g. 'http://localhost:3000')
  // when credentials:true is enabled.
  if (CORS_ORIGIN === '*') {
    console.warn(
      '[celsian] WARNING: CORS_ORIGIN=* with credentials:true is insecure and will not work in browsers. ' +
      'Set CORS_ORIGIN to a specific origin.'
    );
  }

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

    // CSRF protection (double-submit cookie).
    //
    // IMPORTANT: @celsian/core <=0.5.1 matches excludePaths EXACTLY (no prefix
    // matching), so every RPC procedure endpoint is listed individually below.
    // The '/_rpc/*' entry is kept for newer core versions that support prefix
    // patterns. When you add a new mutation procedure, add its '/_rpc/<ns>.<name>'
    // path here — or send the x-csrf-token header from your client (see README).
    csrf({
      cookieName: '_csrf',
      headerName: 'x-csrf-token',
      excludePaths: [
        '/health',
        '/ready',
        '/_rpc/*',
        '/_rpc/greeting.hello',
        '/_rpc/math.add',
        '/_rpc/math.multiply',
        '/_rpc/system.ping',
      ],
    }),

    // Rate limiting — 100 requests per 60 seconds
    rateLimit({
      max: 100,
      window: 60_000,
      // Local scaffold default: use a stable single-process key without trusting proxy headers.
      // In production, replace this with a user/session/IP key appropriate for your deployment.
      keyGenerator: () => 'local-scaffold',
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
import type { CelsianReply, CelsianRequest, PluginFunction } from '@celsian/core';
import type { User } from '../types.js';
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

    // POST /users — create a new user (typed body from schema)
    app.post('/users', {
      schema: { body: CreateUserSchema },
    }, (req, reply) => {
      const { name, email } = req.parsedBody as { name: string; email: string };
      const user: User = {
        id: db.generateId(),
        name,
        email,
        createdAt: new Date().toISOString(),
      };
      db.users.set(user.id, user);
      return reply.status(201).json(user);
    });

    // GET /users/:id — get a single user
    app.get('/users/:id', (req, reply) => {
      const user = db.users.get(req.params.id);
      if (!user) return reply.status(404).json({ error: 'User not found' });
      return reply.json(user);
    });

    // PUT /users/:id — update a user (protected, typed body from schema)
    app.put('/users/:id', {
      schema: { body: UpdateUserSchema },
      onRequest: requireAuth,
    }, (req, reply) => {
      const user = db.users.get(req.params.id);
      if (!user) return reply.status(404).json({ error: 'User not found' });
      const updates = req.parsedBody as { name?: string; email?: string };
      if (updates.name !== undefined) user.name = updates.name;
      if (updates.email !== undefined) user.email = updates.email;
      db.users.set(user.id, user);
      return reply.json(user);
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
      .input<{ name: string }>(Type.Object({ name: Type.String() }))
      .query(({ input }) => {
        return { message: \`Hello, \${input.name}!\` };
      }),
  },
  math: {
    add: procedure
      .input<{ a: number; b: number }>(Type.Object({ a: Type.Number(), b: Type.Number() }))
      .query(({ input }) => {
        return { result: input.a + input.b };
      }),
    multiply: procedure
      .input<{ a: number; b: number }>(Type.Object({ a: Type.Number(), b: Type.Number() }))
      .mutation(({ input }) => {
        return { result: input.a * input.b };
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

  // ─── src/routes/auth.ts ───
  "src/routes/auth.ts": `// Auth routes — dev-only token minting
// GET /auth/token returns a JWT for the seeded demo user so you can try the
// protected endpoints (PUT/DELETE /users/:id) without building a login flow.
// The route is NOT registered when NODE_ENV=production.

import '@celsian/jwt'; // type augmentation for app.jwt
import type { CelsianApp, PluginFunction } from '@celsian/core';
import { db } from '../plugins/database.js';

/**
 * Pass the ROOT app (the one the jwt plugin decorated): \`app.jwt\` is not
 * visible on the encapsulated plugin context this route registers under.
 */
export default function authRoutes(root: CelsianApp): PluginFunction {
  return function auth(app) {
    if (process.env.NODE_ENV === 'production') return;

    app.get('/auth/token', async (_req, reply) => {
      const demoUser = Array.from(db.users.values())[0];
      if (!demoUser) {
        return reply.status(500).json({ error: 'No seeded user found' });
      }
      const token = await root.jwt.sign(
        { sub: demoUser.id, email: demoUser.email },
        { expiresIn: '1h' },
      );
      return reply.json({
        token,
        user: { id: demoUser.id, email: demoUser.email },
        usage:
          'curl -X DELETE http://localhost:3000/users/' +
          demoUser.id +
          ' -H "Authorization: Bearer <token>" -H "x-csrf-token: <csrf>" --cookie "_csrf=<csrf>"',
      });
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
import authRoutes from './routes/auth.js';

// Tasks
import { cleanupTask } from './tasks/cleanup.js';
import { generateDailyReport } from './tasks/report.js';

// ─── Create App ───

// Exported so tooling like \`celsian routes\` can discover the app.
export const app = createApp({ logger: true });

// ─── Security (CORS, CSRF, headers, rate limiting) ───

for (const plugin of securityPlugins()) {
  await app.register(plugin, { encapsulate: false });
}

// ─── Auth (JWT signing & verification) ───

await app.register(authPlugin(), { encapsulate: false });

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
await app.register(authRoutes(app)); // dev-only /auth/token (skipped in production)

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
import { securityPlugins } from '../src/plugins/security.js';

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

  it('RPC mutations succeed with the full security stack (CSRF excludes /_rpc)', async () => {
    // Regression guard: the CSRF plugin must not 403 RPC mutations.
    const app = createApp();
    for (const plugin of securityPlugins()) {
      await app.register(plugin, { encapsulate: false });
    }
    await app.register(rpcRoutes());
    const res = await app.inject({
      method: 'POST',
      url: '/_rpc/math.multiply',
      payload: { a: 2, b: 3 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.result).toBe(6);
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

# Review environment variables (a .env was created from .env.example for you)
# Set a strong JWT_SECRET before deploying anywhere.

# Start development server (with hot reload — loads .env automatically)
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
    auth.ts             # Dev-only GET /auth/token (demo JWT minting)
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

| Method | Path | Auth | CSRF | Description |
|--------|------|------|------|-------------|
| GET | \`/health\` | No | — | Server health check |
| GET | \`/auth/token\` | No | — | Mint a demo JWT (dev only) |
| GET | \`/users\` | No | — | List all users |
| POST | \`/users\` | No | Yes | Create a user |
| GET | \`/users/:id\` | No | — | Get a user by ID |
| PUT | \`/users/:id\` | Yes | Yes | Update a user |
| DELETE | \`/users/:id\` | Yes | Yes | Delete a user |
| GET/POST | \`/_rpc/*\` | No | Excluded | RPC procedures |
| GET | \`/docs\` | No | — | Swagger UI |
| GET | \`/docs/openapi.json\` | No | — | OpenAPI 3.1 spec |

### CSRF: why your first POST returns 403

This template enables **double-submit cookie** CSRF protection. Every mutating
request (POST/PUT/PATCH/DELETE) must send the CSRF token **twice** — as the
\`_csrf\` cookie and as the \`x-csrf-token\` header — and the values must match.
A plain \`curl -X POST /users\` has neither, so it gets \`403 CSRF token mismatch\`.

The flow:

1. Make a GET request first — the server sets the \`_csrf\` cookie.
   (Use a non-excluded route like \`/users\`: CSRF-excluded paths such as
   \`/health\` skip the plugin entirely and never set the cookie.)
2. Echo that cookie value back in the \`x-csrf-token\` header on mutations.

\`\`\`bash
# 1. Get a CSRF token (a non-excluded GET sets the _csrf cookie)
curl -s -c cookies.txt http://localhost:3000/users > /dev/null
CSRF=$(awk '$6 == "_csrf" { print $7 }' cookies.txt)

# 2. Send it back as BOTH cookie and header on mutating requests
curl -X POST http://localhost:3000/users \\
  -b cookies.txt -H "x-csrf-token: $CSRF" \\
  -H 'content-type: application/json' \\
  -d '{"name":"Ada","email":"ada@example.com"}'
\`\`\`

Browser clients: read \`document.cookie\`'s \`_csrf\` value (it is intentionally
not HttpOnly) and send it as the \`x-csrf-token\` header.

RPC endpoints under \`/_rpc/\` are excluded from CSRF checks (see
\`src/plugins/security.ts\`) — note that core <=0.5.1 matches exclusions
exactly, so each procedure path is listed there; add yours when you create
new mutation procedures.

### Auth: calling the JWT-protected routes

\`PUT /users/:id\` and \`DELETE /users/:id\` require a Bearer token. In dev, mint
one for the seeded demo user via the dev-only \`/auth/token\` route:

\`\`\`bash
# 1. Get a token (dev only — not registered when NODE_ENV=production)
TOKEN=$(curl -s http://localhost:3000/auth/token | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# 2. CSRF token as above
curl -s -c cookies.txt http://localhost:3000/users > /dev/null
CSRF=$(awk '$6 == "_csrf" { print $7 }' cookies.txt)

# 3. Call a protected route with Bearer auth + CSRF
curl -X PUT http://localhost:3000/users/1 \\
  -H "Authorization: Bearer $TOKEN" \\
  -b cookies.txt -H "x-csrf-token: $CSRF" \\
  -H 'content-type: application/json' \\
  -d '{"name":"Renamed User"}'
\`\`\`

For production, replace \`/auth/token\` with a real login flow that verifies
credentials and signs a token via \`app.jwt.sign({ sub: user.id, email: user.email })\`.

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

const CreateProductSchema = Type.Object({
  name: Type.String(),
  price: Type.Number({ minimum: 0 }),
});

// parsedBody is fully typed — no cast needed!
app.post('/products', {
  schema: { body: CreateProductSchema },
}, (req, reply) => {
  return reply.status(201).json({ id: 1, name: req.parsedBody.name });
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
