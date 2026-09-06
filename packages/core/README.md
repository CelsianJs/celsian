# @celsian/core

The CelsianJS server runtime: radix-tree router, Fastify-style hook lifecycle, plugin encapsulation, schema validation, background tasks, cron, SSE, and WebSocket.

Built on Web Standard `Request`/`Response`, so the same app runs on Node.js, Bun, Deno, Cloudflare Workers, AWS Lambda, and Vercel. The only runtime dependency is `@celsian/schema`.

## Install

```bash
npm install @celsian/core
```

Requires Node.js 20+. ESM only.

## Quick start

```ts
import { createApp, serve } from '@celsian/core';

const app = createApp({ logger: true });

app.get('/hello/:name', (req, reply) => {
  return reply.json({ message: `Hello, ${req.params.name}!` });
});

serve(app, { port: 3000 });
```

## Routing

Shorthands: `app.get`, `app.post`, `app.put`, `app.patch`, `app.delete`. Any other method (or several at once) goes through `app.route({ method, url, handler })`. Params are `:name`, wildcards are `*name`.

```ts
app.get('/users/:id', (req, reply) => reply.json({ id: req.params.id }));
app.route({ method: ['GET', 'POST'], url: '/_rpc/*path', handler: (req) => rpc.handle(req) });
```

`app.getRoutes()` returns the registered route table (this is what `celsian routes` prints).

## Testing with `inject()`

`app.inject()` runs a request through the full hook lifecycle in-process, with no server and no open port. It returns a standard `Response`.

```ts
import { createApp } from '@celsian/core';

const app = createApp();
app.get('/ping', (_req, reply) => reply.json({ pong: true }));

const res = await app.inject({ url: '/ping' });
console.log(res.status, await res.json());  // 200 { pong: true }
```

`inject()` accepts `{ method, url, payload, headers, cookies }`.

Because it returns a standard `Response`, the status property is **`res.status`**, not Fastify's `res.statusCode`. `res.statusCode` is `undefined`, so `expect(res.statusCode).toBe(200)` fails rather than silently passing. Body access is async: `await res.json()` / `await res.text()`.

## Reply helpers

`reply.json()`, `.send()`, `.html()`, `.stream()`, `.redirect()`, `.sendFile()`, `.download()`, `.cookie()`, `.clearCookie()`, `.status()`, `.header()`, plus status shortcuts: `.notFound()`, `.badRequest()`, `.unauthorized()`, `.forbidden()`, `.conflict()`, `.gone()`, `.tooManyRequests()`, `.internalServerError()`, `.serviceUnavailable()`.

## Schema validation

Attach `schema.body`, `schema.querystring`, or `schema.response` to a route. Zod, TypeBox, and Valibot are auto-detected. Validated data lands on `req.parsedBody` / `req.parsedQuery`, and a validation failure returns 400 before your handler runs.

```ts
import { Type } from '@sinclair/typebox';

const CreateUser = Type.Object({ name: Type.String(), age: Type.Number() });

app.post('/users', { schema: { body: CreateUser } }, (req, reply) => {
  // req.parsedBody is typed { name: string; age: number }
  return reply.status(201).json(req.parsedBody);
});
```

## Hooks

Lifecycle order: `onRequest` -> `preHandler` -> handler -> `onSend` -> `onResponse`. Thrown errors go to `onError`.

```ts
app.addHook('onRequest', (req, reply) => {
  if (!req.headers.get('authorization')) return reply.unauthorized();
});
```

Hooks can also be attached per route via `{ onRequest, preHandler, ... }` in the route options.

## Plugins and encapsulation

A plugin is a function receiving a scoped app. Hooks and decorations registered inside stay inside, unless you pass `{ encapsulate: false }`.

```ts
import type { PluginFunction } from '@celsian/core';

function productRoutes(): PluginFunction {
  return function products(app) {
    app.get('/products', (_req, reply) => reply.json([]));
  };
}

await app.register(productRoutes());
```

## Built-in plugins

| Plugin | Purpose |
|--------|---------|
| `cors(options)` | CORS headers and preflight |
| `security(options)` | Helmet-style headers (HSTS, referrer policy, ...) |
| `csrf(options)` | Double-submit-cookie CSRF protection |
| `openapi(options)` | OpenAPI 3.1 spec + Swagger UI at `/docs` |
| `upload(options)` | Multipart file uploads |
| `withETag(options)` | ETag generation and 304 handling |
| `database(options)` | Pool decoration, `withTransaction`, `transactionLifecycle` |
| `dbAnalytics` / `slowQueryLogger` / `dbTimingHeader` / `trackedPool` | Query instrumentation |

`excludePaths` on `csrf()` matches exactly **or** as a path-segment prefix: `'/_rpc'` covers `/_rpc/anything` but not `/_rpcx`.

```ts
import { cors, csrf, security, openapi } from '@celsian/core';

await app.register(cors({ origin: 'https://example.com', credentials: true }), { encapsulate: false });
await app.register(security({ hsts: { maxAge: 31536000 } }), { encapsulate: false });
await app.register(csrf({ excludePaths: ['/health', '/_rpc'] }), { encapsulate: false });
await app.register(openapi({ title: 'My API', version: '1.0.0' }));
```

Rate limiting, JWT auth, compression and caching live in separate packages (`@celsian/rate-limit`, `@celsian/jwt`, `@celsian/compress`, `@celsian/cache`).

### Documenting authentication and CSRF

Declare available HTTP or API-key schemes in `openapi({ securitySchemes })`, then
add requirements only to the routes that enforce them. Swagger UI displays an
**Authorize** control for these schemes. Route `openapi` metadata is documentation
only: it never installs authentication hooks, disables CSRF, or changes validation.

```ts
await app.register(openapi({
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
}));

app.put('/users/:id', {
  onRequest: requireAuth, // Your JWT guard; keep runtime enforcement explicit.
  openapi: {
    security: [{ bearerAuth: [] }],
    parameters: [{
      name: 'x-csrf-token', in: 'header', required: true,
      description: 'Must match the _csrf cookie issued by a previous GET.',
      schema: { type: 'string' },
    }],
  },
}, updateUser);
```

`openapi.description` adds operation documentation; `openapi.parameters` appends
to schema-derived query/path parameters. Omit `openapi.security` for public
operations, or use `[]` to explicitly document no authentication. Auth requirements
are never inferred from hooks. A CSRF cookie is sent automatically by same-origin
browsers, but callers must still supply the matching header.

## Background tasks and cron

```ts
app.task({
  name: 'send-email',
  retries: 3,
  timeout: 10_000,
  async handler(input, ctx) {
    ctx.log.info('sending');
  },
});

await app.enqueue('send-email', { to: 'user@example.com' });

app.cron('nightly-cleanup', '0 3 * * *', async () => {
  await app.enqueue('send-email', { to: 'admin@example.com' });
});
```

`serve()` starts the task worker and cron scheduler for you. **If you are not using `serve()`** (tests, serverless), call `app.startWorker()` and `app.startCron()` yourself or tasks silently never run. The worker polls every second by default, so an enqueued task is not processed synchronously. Cron needs a long-running process, so on serverless use the platform's own scheduler.

## Server-sent events

```ts
import { createSSEHub } from '@celsian/core';

const hub = createSSEHub();

app.get('/events', (req) => {
  const channel = hub.subscribe(req);
  return channel.response;
});

hub.broadcast({ event: 'tick', data: { at: Date.now() } });
```

## WebSocket

```ts
app.ws('/socket', {
  open(conn) { conn.send('welcome'); },
  message(conn, data) { conn.send(`echo: ${data}`); },
});
```

WebSocket upgrades are served by `serve()` on Node. Other runtimes need their platform adapter.

## Errors

Use the structured error classes rather than bare `Error`, so the error handler can produce a correct status and body.

```ts
import { HttpError, ValidationError, CelsianError } from '@celsian/core';

throw new HttpError(404, 'User not found');
```

## Config

```ts
import { defineConfig, loadConfig } from '@celsian/core';

export default defineConfig({ server: { port: 3000 } });
```

## Documentation

Full docs, guides, and examples: [github.com/CelsianJs/celsian](https://github.com/CelsianJs/celsian)

## License

MIT
