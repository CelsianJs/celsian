# CelsianJS

[![npm version](https://img.shields.io/npm/v/celsian)](https://www.npmjs.com/package/celsian)
[![license](https://img.shields.io/npm/l/celsian)](https://github.com/CelsianJs/celsian/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/CelsianJs/celsian/test.yml?branch=main&label=tests)](https://github.com/CelsianJs/celsian/actions)

The batteries-included TypeScript backend that goes serverless without leaving its batteries behind. Built on Web Standard APIs -- one app deploys to Node.js, Bun, Deno, Cloudflare Workers, AWS Lambda, Vercel.

- **Durable jobs that cross the serverless boundary** -- Background tasks with retries and cron, built in. Run them in-process on a long-lived server, or back them with `@celsian/queue-redis` so a serverless producer and a hot-server worker share one queue. No separate BullMQ worker process to stand up.
- **Built-in everything** -- Background tasks, cron, WebSocket, CORS, CSRF protection, security headers, DB analytics, rate limiting, JWT, caching, compression, OpenAPI docs. No plugin scavenger hunt.
- **Multi-runtime** -- Write once, deploy to any JavaScript runtime. Built on `Request`/`Response`, not `req`/`res`.
- **Fastify-style plugin encapsulation** -- A plugin registered with a `prefix` is encapsulated: its decorations and all four hook types stay inside that prefix. A plugin registered without a prefix is app-wide, which is what makes `app.register(cors())` work as middleware. See [Plugin Encapsulation](#plugin-encapsulation).
- **Schema-agnostic validation** -- Auto-detects Zod, TypeBox, or Valibot. No config, no adapters.

> **On performance:** Celsian is **not** the fastest option, and a previous claim here that it
> was 1.25x-2.3x faster than Express has been withdrawn as unsupported. Re-measured with a
> rigorous harness on 2026-07-26, Celsian ranked last of Fastify, Hono, Express and Celsian in
> all five scenarios. See [Honest Benchmarks](#honest-benchmarks). Speed isn't the reason to
> pick Celsian; the durable-job-to-serverless story is.

## Quick Start

```bash
npx create-celsian my-api
cd my-api
npm install
npm run dev
```

Or manually:

```bash
npm install @celsian/core
npm pkg set type=module   # CelsianJS is ESM-only
```

> **CelsianJS is ESM-only.** Set `"type": "module"` in your `package.json` (the command above does this). Without it, Node treats your files as CommonJS and `@celsian/schema` fails to load with `Top-level await is currently not supported with the "cjs" output format`.

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

**Retracted 2026-07-26: CelsianJS is not faster than Express.** This section used to claim
"1.25x to 2.3x faster than Express". That claim came from a benchmark harness that could not
support it: it never checked for errors or non-2xx responses, did no warmup, ran a single
pass per cell while publishing five significant figures, and ran every framework in one
shared process in a fixed order, competing with the load generator for CPU.

The harness has been rewritten (process isolation, readiness polling, real warmup, n=5 with
median and 95% CI, randomized ordering, hard failure on any bad HTTP). With the fixed
harness the result reverses: **CelsianJS ranked last of four frameworks in all five
scenarios, and Express won 24 of 25 paired within-repetition comparisons.**

No replacement numbers are published here, because the only available run was on a loaded
developer laptop where the worst relative standard deviation was 34%. The ranking is
consistent enough to state; the magnitudes are not. Fresh figures are pending a run on
dedicated, idle hardware.

Full data, methodology and the trustworthiness assessment are in
[`benchmarks/RESULTS.md`](benchmarks/RESULTS.md). Reproduce with `pnpm bench`.

The one clean, reproducible deficit worth acting on: **error handling runs at about 0.58x
Express**, with a tight spread on both sides. The error path is not fast-pathed, and that is
a known gap.

**Speed is not the reason to choose CelsianJS.** If raw throughput is your only concern, use
Fastify. CelsianJS trades throughput for multi-runtime portability and for application
infrastructure that neither Fastify nor Express includes: background task queues, cron
scheduling, and DB analytics in one framework.

### Built-In Everything

No hunting for middleware packages:

```typescript
// A plugin registered WITHOUT a prefix applies to every route in the app, so
// these work as middleware. `{ encapsulate: false }` says the same thing
// explicitly and is still supported; it is no longer required.
// To scope a plugin instead, give it a prefix: `{ prefix: '/admin' }`.
await app.register(security());                          // Helmet-style headers
await app.register(cors({ origin: 'https://myapp.com' }));
await app.register(csrf(), { encapsulate: false });      // CSRF token protection
// The limiter needs a trustworthy way to identify a client, so it throws at
// registration rather than run without one. In order of preference:
//   1. keyGenerator on an authenticated user id (immune to header spoofing)
//   2. trustedProxies: the CIDRs of proxies you actually run
//   3. trustProxy: true, which trusts X-Forwarded-For unconditionally. Only use
//      this when a proxy you control REWRITES that header; if anything can reach
//      the app directly, a client can rotate the header and bypass the limit.
await app.register(rateLimit({ max: 100, window: 60_000, trustedProxies: ['10.0.0.0/8'] }));
await app.register(compress());
await app.register(jwt({ secret: process.env.JWT_SECRET! }), { encapsulate: false });
await app.register(openapi({ title: 'My API' }));

app.health();                                             // /health + /ready
app.task({ name: 'email', handler, retries: 3 });        // Background tasks
app.cron('cleanup', '0 3 * * *', cleanupHandler);        // Cron jobs
app.ws('/chat', { open, message, close });                // WebSocket
```

> **WebSocket note.** WebSocket is supported on Node (via `serve()`) and Bun (via `@celsian/adapter-bun`) today, not yet on Deno, Cloudflare Workers, or other adapters. On **Node**, WebSocket needs the `ws` package, which is not bundled: `npm i ws`. Bun serves WebSockets natively, with no extra install.

### Plugin Encapsulation

Plugins get isolated scopes by default. Decorations, and `onRequest` / `preHandler` hooks, registered inside a plugin do not leak to sibling plugins or the parent scope.

> **Fixed in 0.6.0.** All four hook types (`onRequest`, `preHandler`, `onSend`,
> `onResponse`) are scoped to the plugin's prefix. Re-verified against a plugin
> registering all four under `/p`: routes inside it saw all four, while a sibling
> plugin and a bare `GET /outside` saw none. Earlier releases discarded
> `onRequest`/`preHandler` and leaked `onSend`/`onResponse` to every ancestor.

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
| **Real-time** | WebSocket with broadcast and connection management; [Server-Sent Events](docs/sse.md) (single stream or broadcast hub, works on every runtime) |
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
// File serving is confined: `root` defaults to process.cwd(), and any resolved
// path outside it is a 403, symlinks included. Pass `root` to serve elsewhere.
await reply.sendFile('reports/q3.pdf');                          // relative to cwd
await reply.sendFile('q3.pdf', { root: '/srv/reports' });        // explicit root
await reply.download('data.csv', { root: '/srv/exports', filename: 'export.csv' });

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

See the [Error Reference](docs/errors.md) for every error `code`, its cause, and how to fix it.

### Type-Safe RPC

`@celsian/rpc` provides tRPC-style procedures with type inference, middleware, and OpenAPI generation.

```typescript
// server.ts
import { procedure, router, RPCHandler } from '@celsian/rpc';
import { z } from 'zod';

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
import { createRPCClient } from '@celsian/rpc/client';
import type { AppRouter } from './server.js';

const client = createRPCClient<AppRouter>({ baseUrl: 'http://localhost:3000/_rpc' });
// Both calls are fully typed: the input is checked against the procedure's
// schema, and the result is the procedure's return type.
const users = await client.users.list.query({ limit: 10 });
const newUser = await client.users.create.mutate({ name: 'Bob', email: 'bob@example.com' });
```

## Try the Demo

The [SaaS Demo](examples/saas-demo/) builds a complete backend in one file (~250 lines): JWT auth, users CRUD, background tasks, cron, SSE, and OpenAPI docs.

The example depends on workspace packages (`@celsian/*` via the `workspace:` protocol), so install and build from the repo root with pnpm, `npm install` inside the example folder fails because npm can't resolve `workspace:`.

```bash
# From the repo root
pnpm install
pnpm build
pnpm --filter @celsian/example-saas-demo start
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
| `@celsian/compress` | Response compression (gzip/deflate via CompressionStream) |
| `@celsian/queue-redis` | Redis-backed task queue for production |

### Deployment Adapters

| Package | Target |
| ------- | ------ |
| `@celsian/adapter-node` | Standalone Node.js server |
| `@celsian/adapter-bun` | Bun (`Bun.serve`, native WebSocket) |
| `@celsian/adapter-deno` | Deno (`Deno.serve`) |
| `@celsian/adapter-cloudflare` | Cloudflare Workers (env bindings, execution context) |
| `@celsian/adapter-lambda` | AWS Lambda + API Gateway v2 |
| `@celsian/adapter-vercel` | Vercel Serverless + Edge Functions |
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

**The previously published table here has been withdrawn.** It was produced by a harness
with four independently disqualifying defects, and the numbers do not reproduce. See
[Honest Benchmarks](#honest-benchmarks) above for what happened and
[`benchmarks/RESULTS.md`](benchmarks/RESULTS.md) for the full write-up.

Current state, measured 2026-07-26 with the rewritten harness (CelsianJS, Express, Fastify,
Hono; 10 connections; 2s warmup discarded; n=5; randomized order; separate process per
server):

- CelsianJS ranked **last of four in all five scenarios**.
- Express won **24 of 25** paired within-repetition comparisons.
- The clearest deficit is **error handling, at roughly 0.58x Express**, which is the one
  cell tight enough on both sides to state with confidence.

Absolute req/s figures are deliberately not repeated here. The run was on a loaded laptop
(worst relative standard deviation 34%), which is enough to establish a ranking but not to
publish magnitudes. Republishing numbers requires a run on an idle machine with worst SD
under about 5%.

Reproduce with `pnpm bench`. The harness now fails the run outright on any socket error,
timeout, or unexpected status code, so a broken server can no longer be reported as a
result.

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
- [Server-Sent Events](docs/sse.md)
- [Deployment Guide](docs/deployment.md)
- [Database Plugin](docs/database.md)
- [Error Reference](docs/errors.md)
- **[Migrating from Fastify](docs/migration-from-fastify.md)** -- side-by-side conversion
  of routes, hooks, plugins, decorators, validation and error handling

## WhatStack

CelsianJS is the backend half of [WhatStack](https://whatfw.com), the agent-first full-stack framework:

| Layer | Framework | What It Does |
|-------|-----------|-------------|
| Frontend | [WhatFW](https://whatfw.com) | Signals, fine-grained rendering, MCP DevTools |
| Backend | **CelsianJS** | Hooks, plugins, tasks, cron, RPC, multi-runtime |
| Deploy | Vura | Platform deployment (coming soon) |

## Contributing

```bash
git clone https://github.com/CelsianJs/celsian.git
cd celsian
pnpm install
pnpm build   # build all packages first, tests import from built dist/
pnpm test
```

The project uses pnpm workspaces. All packages are in `packages/`. Tests use Vitest. Run `pnpm build` before `pnpm test`: many test files import workspace packages from their built output, so they fail on a fresh clone until the build runs once.

## License

MIT
