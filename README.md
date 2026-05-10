# CelsianJS

TypeScript backend framework built on Web Standard APIs. Runs everywhere -- Node.js, Bun, Deno, Cloudflare Workers, AWS Lambda, Vercel.

- **Multi-runtime** -- Write once, deploy to any JavaScript runtime. Built on `Request`/`Response`, not `req`/`res`.
- **Significantly faster than Express** -- Radix-tree router, zero-copy request building, pre-stringified error paths. 1.3x-1.7x faster across all scenarios.
- **Built-in everything** -- Background tasks, cron, WebSocket, CORS, CSRF protection, security headers, DB analytics, rate limiting, JWT, caching, compression, OpenAPI docs.
- **Fastify-style plugin encapsulation** -- Scoped hooks and decorations by default. No accidental middleware leaks.
- **Schema-agnostic validation** -- Auto-detects Zod, TypeBox, or Valibot. No config, no adapters.

## Quick Start

```bash
npx create-celsian my-api
cd my-api
npm run dev
```

Or manually:

```bash
npm install @celsian/core
```

```typescript
import { createApp, serve } from '@celsian/core';

const app = createApp({ logger: true });

// ─── Background tasks with retries ───
app.task({
  name: 'sendWelcomeEmail',
  retries: 3,
  async handler(input: { to: string }) {
    await sendEmail(input.to, 'Welcome!');
  },
});

// ─── Cron job: clean up expired sessions every night ───
app.cron('cleanup', '0 3 * * *', async () => {
  await db.query('DELETE FROM sessions WHERE expires_at < NOW()');
});

// ─── API routes ───
app.post('/users', async (req, reply) => {
  const body = req.parsedBody as { name: string; email: string };
  const user = await db.createUser(body);
  await app.enqueue('sendWelcomeEmail', { to: body.email });
  return reply.status(201).json(user);
});

app.get('/users/:id', (req, reply) => {
  return reply.json({ id: req.params.id, name: 'Alice' });
});

serve(app, { port: 3000 });
```

Tasks, cron, and API routes in one file -- no separate worker process needed. On Bun or Deno, `serve()` auto-detects the runtime. No code changes needed.

```bash
bun run server.ts   # Uses Bun.serve() automatically
deno run server.ts  # Uses Deno.serve() automatically
```

## Why CelsianJS

### Multi-Runtime

Built on Web Standard `Request`/`Response` -- not Node.js `IncomingMessage`/`ServerResponse`. One adapter line deploys anywhere:

```typescript
export default createCloudflareHandler(app);          // Cloudflare Workers
export const handler = createLambdaHandler(app);      // AWS Lambda
export default createVercelEdgeHandler(app);           // Vercel Edge
```

### Honest Benchmarks

Benchmarked on Node.js v22, Apple Silicon, 10 connections for 10 seconds per scenario:

| Scenario              | Fastify (req/s) | CelsianJS (req/s) | Express (req/s) |
| --------------------- | ---------------: | -----------------: | --------------: |
| JSON response         |           45,866 |             27,996 |          16,321 |
| Route params          |           45,440 |             27,026 |          16,288 |
| Middleware (5 layers)  |           41,380 |             24,445 |          15,751 |
| JSON body parsing     |           29,998 |             19,074 |          14,648 |
| Error handling        |           32,398 |             18,542 |          14,765 |

**Fastify is faster.** It operates directly on Node.js internals with `fast-json-stringify` — hard to beat. CelsianJS pays a performance tax for Web Standard API compatibility (`Request`/`Response` object creation per request).

**CelsianJS is 1.3-1.7x faster than Express** while shipping batteries that neither Fastify nor Express include: background task queues, cron scheduling, multi-runtime deployment, and DB analytics. If raw throughput is your only concern, use Fastify. If you need application infrastructure in a single framework, that's where CelsianJS fits.

### Built-In Everything

No hunting for middleware packages:

```typescript
await app.register(security(), { encapsulate: false });  // Helmet-style headers
await app.register(cors({ origin: 'https://myapp.com' }));
await app.register(csrf(), { encapsulate: false });      // CSRF token protection
await app.register(rateLimit({ max: 100, window: 60_000 }));
await app.register(compress());
await app.register(jwt({ secret: process.env.JWT_SECRET! }));
await app.register(openapi({ title: 'My API' }));

app.health();                                             // /health + /ready
app.task({ name: 'email', handler, retries: 3 });        // Background tasks
app.cron('cleanup', '0 3 * * *', cleanupHandler);        // Cron jobs
app.ws('/chat', { open, message, close });                // WebSocket
```

### Plugin Encapsulation

Plugins get isolated scopes by default. Hooks and decorations registered inside a plugin do not leak to sibling plugins or the parent scope.

```typescript
// Auth plugin -- hooks only apply to routes registered inside
async function authPlugin(app) {
  app.addHook('onRequest', async (req, reply) => {
    const token = req.headers.get('authorization');
    if (!token) return reply.unauthorized();
  });

  app.get('/me', (req, reply) => {
    return reply.json({ user: req.user });
  });
}

// Public routes -- no auth required
app.get('/health', (req, reply) => reply.json({ status: 'ok' }));

// Register auth plugin under /api prefix
await app.register(authPlugin, { prefix: '/api' });
```

Use `{ encapsulate: false }` when a plugin should affect all routes (e.g., CORS, database):

```typescript
await app.register(cors(), { encapsulate: false });
```

### Type-Safe Schema Validation

Pass any Zod, TypeBox, or Valibot schema. CelsianJS auto-detects the library.

```typescript
app.route({
  method: 'POST',
  url: '/users',
  schema: {
    body: z.object({ name: z.string().min(1), email: z.string().email() }),
  },
  handler(req, reply) {
    const { name, email } = req.parsedBody as { name: string; email: string };
    return reply.status(201).json({ id: '1', name, email });
  },
});
// Invalid input returns 400 with structured issues automatically
```

## Features at a Glance

| Category | Features |
| -------- | -------- |
| **Routing** | Radix-tree router, params, wildcards, HEAD fallback, 405, route tagging |
| **Hooks** | 8-hook lifecycle (onRequest through onResponse), route-level hooks |
| **Plugins** | Scoped encapsulation, app/request/reply decorators |
| **Validation** | Zod, TypeBox, Valibot auto-detect; body, querystring, params schemas |
| **Reply** | json, html, stream, redirect, sendFile, download, cookies, 9 error helpers |
| **Security** | Helmet-style headers, CORS, CSRF protection, JWT, fixed-window rate limiting |
| **Background** | Task queue with retries, cron scheduling, Redis queue backend |
| **Real-time** | WebSocket with broadcast and connection management |
| **Database** | Connection pool plugin, transactions, query analytics, Server-Timing |
| **Caching** | Response cache, session management (KV store) |
| **Infra** | Compression, OpenAPI 3.1 + Swagger UI, structured logging, inject() testing |
| **Deploy** | Node, Bun, Deno, Workers, Lambda, Vercel, Fly.io, Railway, graceful shutdown |

## Core Concepts

### Routes and Handlers

```typescript
app.get('/users/:id', (req, reply) => {
  return reply.json({ id: req.params.id, include: req.query.include });
});

// Full route options with schema, hooks, and deployment tagging
app.route({
  method: 'POST',
  url: '/items',
  kind: 'serverless',
  schema: { body: mySchema },
  preHandler: [authHook],
  handler(req, reply) { return reply.status(201).json(req.parsedBody); },
});
```

### Hooks Lifecycle

8 hooks run in order: `onRequest` > `preParsing` > `preValidation` > `preHandler` > `handler` > `preSerialization` > `onSend` > `onResponse`. Plus `onError` for error handling. Any hook can short-circuit by returning a `Response`.

```typescript
// Global hook
app.addHook('onRequest', async (req, reply) => {
  reply.header('x-request-id', crypto.randomUUID());
});

// Route-level hook
app.route({
  method: 'POST',
  url: '/admin/users',
  onRequest: [requireAdmin],
  handler(req, reply) { return reply.json({ created: true }); },
});
```

See [Hooks Lifecycle](docs/hooks.md) for the complete guide.

### Reply Helpers

```typescript
reply.json({ data: [] });                            // JSON response
reply.html('<h1>Hello</h1>');                         // HTML response
reply.stream(readableStream);                         // Streaming
reply.redirect('/new-path', 301);                     // Redirect
await reply.sendFile('/path/to/report.pdf');          // Serve file
await reply.download('/path/to/data.csv', 'export');  // Download

// Structured error responses
reply.notFound('User not found');     // 404
reply.badRequest('Missing email');    // 400
reply.unauthorized('Token expired');  // 401
reply.forbidden();                    // 403
reply.conflict();                     // 409
reply.tooManyRequests();              // 429

// Cookies + chaining
reply.cookie('session', token, { httpOnly: true, secure: true });
return reply.status(201).header('x-custom', 'value').json({ id: '1' });
```

### Error Handling

Thrown errors are caught and returned as structured JSON. Stack traces are stripped in production.

```typescript
import { HttpError } from '@celsian/core';

// Throw HTTP errors anywhere
throw new HttpError(403, 'Forbidden');
// { "error": "Forbidden", "statusCode": 403, "code": "FORBIDDEN" }

// Custom error handler
app.setErrorHandler((error, req, reply) => {
  if (error.message.includes('UNIQUE constraint')) return reply.conflict();
  return reply.internalServerError();
});
```

### Type-Safe RPC

`@celsian/rpc` provides tRPC-style procedures with type inference, middleware, and OpenAPI generation.

```typescript
// server.ts
import { procedure, router, RPCHandler } from '@celsian/rpc';

const appRouter = router({
  users: {
    list: procedure
      .input(z.object({ limit: z.number().optional() }))
      .query(async ({ input }) => [{ id: '1', name: 'Alice' }]),
    create: procedure
      .input(z.object({ name: z.string(), email: z.string().email() }))
      .mutation(async ({ input }) => ({ id: '2', ...input })),
  },
});

const rpc = new RPCHandler(appRouter);
app.route({ method: ['GET', 'POST'], url: '/_rpc/*path', handler: (req) => rpc.handle(req) });
export type AppRouter = typeof appRouter;

// client.ts
const client = createRPCClient<AppRouter>({ baseUrl: 'http://localhost:3000/_rpc' });
const users = await client.users.list.query({ limit: 10 });
const newUser = await client.users.create.mutate({ name: 'Bob', email: 'bob@example.com' });
```

## Try the Demo

The [SaaS Demo](examples/saas-demo/) builds a complete backend in one file (~250 lines): JWT auth, users CRUD, background tasks, cron, SSE, and OpenAPI docs.

```bash
cd examples/saas-demo
npm install
npx tsx src/index.ts
```

Then hit `http://localhost:3000/docs` for the Swagger UI, or:

```bash
# Register
curl -X POST http://localhost:3000/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"secret123","name":"Alice"}'

# Login and grab the token
curl -X POST http://localhost:3000/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"secret123"}'
```

## Ecosystem

### Core Packages

| Package | Description |
| ------- | ----------- |
| `@celsian/core` | Server runtime, routing, hooks, plugins, task queue, cron, WebSocket, CORS, security, database, OpenAPI |
| `@celsian/schema` | Standard Schema adapters -- auto-detects Zod, TypeBox, Valibot |
| `@celsian/rpc` | Type-safe RPC procedures, middleware, OpenAPI generation, typed client |
| `@celsian/jwt` | JWT sign/verify plugin with route guard helper |
| `@celsian/cache` | KV store, response caching, session management |
| `@celsian/rate-limit` | Fixed-window rate limiter with pluggable store |
| `@celsian/compress` | Response compression (Brotli, gzip, deflate) |
| `@celsian/queue-redis` | Redis-backed task queue for production |

### Deployment Adapters

| Package | Target |
| ------- | ------ |
| `@celsian/adapter-cloudflare` | Cloudflare Workers (env bindings, execution context) |
| `@celsian/adapter-lambda` | AWS Lambda + API Gateway v2 |
| `@celsian/adapter-vercel` | Vercel Serverless + Edge Functions |
| `@celsian/adapter-node` | Standalone Node.js server |
| `@celsian/adapter-fly` | Fly.io (generates fly.toml, Dockerfile, multi-region) |
| `@celsian/adapter-railway` | Railway (generates railway.json, Procfile) |

### Tooling

| Package | Description |
| ------- | ----------- |
| `create-celsian` | Project scaffolder (`npx create-celsian my-api`) |
| `@celsian/cli` | Dev server, route listing, code generation |
| `celsian` | Meta-package for single-import convenience |

## Production Features

### Graceful Shutdown

On SIGTERM/SIGINT: stops accepting connections, drains in-flight requests, stops workers and cron, runs cleanup.

```typescript
serve(app, {
  shutdownTimeout: 15_000,
  onShutdown: () => db.close(),
});
```

### Health Checks and Route Manifest

```typescript
app.health({ check: () => pool.isHealthy() });  // /health + /ready

// Tag routes for deployment tooling
app.route({ method: 'GET', url: '/api/users', kind: 'serverless', handler });
app.route({ method: 'GET', url: '/ws', kind: 'hot', handler });
const manifest = app.getRouteManifest(); // { serverless: [...], hot: [...], task: [...] }
```

### Database Analytics

Wrap your pool with `trackedPool()` for per-request query metrics, `Server-Timing` headers, and slow query logging -- zero handler changes. See [Database Plugin](docs/database.md).

```typescript
const pool = trackedPool(pgPool);
await app.register(database({ createPool: () => pool }), { encapsulate: false });
await app.register(dbAnalytics({ slowThreshold: 100 }), { encapsulate: false });
// Response: Server-Timing: db;dur=12.5;desc="3 queries"
```

### Testing Without a Server

```typescript
const response = await app.inject({ method: 'GET', url: '/hello' });
const body = await response.json();  // { hello: 'world' }
```

## Deployment

Swap the entry point to deploy anywhere. See [Deployment Guide](docs/deployment.md) for full instructions.

```typescript
serve(app, { port: 3000 });                              // Node / Bun / Deno

export default createCloudflareHandler(app);              // Cloudflare Workers
export const handler = createLambdaHandler(app);          // AWS Lambda
export default createVercelHandler(app);                  // Vercel Serverless
export default createVercelEdgeHandler(app);              // Vercel Edge
```

Fly.io and Railway adapters auto-generate deployment configs (fly.toml, Dockerfile, railway.json).

## Benchmark Results

Node.js v22.13.1, macOS Darwin (Apple Silicon), 10 connections, 10s per scenario.

| Scenario              | Fastify (req/s) | CelsianJS (req/s) | Express (req/s) |
| --------------------- | ---------------: | -----------------: | --------------: |
| JSON response         |           45,866 |             27,996 |          16,321 |
| Route params          |           45,440 |             27,026 |          16,288 |
| Middleware (5)        |           41,380 |             24,445 |          15,751 |
| JSON body parsing     |           29,998 |             19,074 |          14,648 |
| Error handling        |           32,398 |             18,542 |          14,765 |

Fastify is the fastest Node.js framework. CelsianJS is 1.3-1.7x faster than Express. The gap with Fastify comes from Web Standard API overhead (`Request`/`Response` per request). CelsianJS trades some throughput for multi-runtime portability and built-in application infrastructure.

## Configuration

CelsianJS loads `celsian.config.ts` (or `.js`/`.mjs`) automatically:

```typescript
import { defineConfig } from '@celsian/core';

export default defineConfig({
  server: { port: 3000, host: 'localhost', trustProxy: true },
  schema: { provider: 'auto' },  // or 'zod' | 'typebox' | 'valibot'
});
```

## Documentation

- [Quick Start Guide](docs/quickstart.md)
- [Hooks Lifecycle](docs/hooks.md)
- [Plugins and Encapsulation](docs/plugins.md)
- [Deployment Guide](docs/deployment.md)
- [Database Plugin](docs/database.md)

## WhatStack

CelsianJS is the backend half of [WhatStack](https://whatfw.com) — the agent-first full-stack framework:

| Layer | Framework | What It Does |
|-------|-----------|-------------|
| Frontend | [WhatFW](https://whatfw.com) | Signals, fine-grained rendering, MCP DevTools |
| Backend | **CelsianJS** | Hooks, plugins, tasks, cron, RPC, multi-runtime |
| Deploy | [Vura](https://github.com/zvndev/vura) | Platform deployment (coming soon) |

## Contributing

```bash
git clone https://github.com/CelsianJs/celsian.git
cd celsian
pnpm install
pnpm test
```

The project uses pnpm workspaces. All packages are in `packages/`. Tests use Vitest.

## License

MIT
