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

`inject()` accepts `{ method, url, payload, headers, cookies, remoteAddress }`. `remoteAddress` is what the handler sees as `req.ip`; without it `req.ip` is `undefined`, since no socket exists.

Because it returns a standard `Response`, the status property is **`res.status`**, not Fastify's `res.statusCode`. `res.statusCode` is `undefined`, so `expect(res.statusCode).toBe(200)` fails rather than silently passing. Body access is async: `await res.json()` / `await res.text()`.

## Reply helpers

`reply.json()`, `.send()`, `.html()`, `.stream()`, `.redirect()`, `.sendFile()`, `.download()`, `.cookie()`, `.clearCookie()`, `.status()`, `.header()`, plus status shortcuts: `.notFound()`, `.badRequest()`, `.unauthorized()`, `.forbidden()`, `.conflict()`, `.gone()`, `.tooManyRequests()`, `.internalServerError()`, `.serviceUnavailable()`.

## Wrapping and inspecting `reply` and `request`

What a handler, hook or plugin can rely on when it reads, copies, wraps or replaces these objects. Anything not listed here is not part of the API. Each statement is a test in [`test/reply-request-contract.test.ts`](test/reply-request-contract.test.ts).

### `reply`

- **Reading and assigning.** `reply.statusCode`, `reply.sent` and `reply.headers` read the reply's state, and assigning `statusCode` or `sent` sets it. `reply.headers` is live: writing to it sets a header. Assigning a method (`reply.send = wrapped`) replaces it on that reply only.
- **Detached methods.** A method read off the reply acts on that reply when called on its own (`const { status, json } = reply`), and `reply.json === reply.json`. Such a function is named `"bound"` and has a `length` of 3.
- **`in`, `for...in` and `Object.keys()`.** `in` and `for...in` see `statusCode`, `sent`, `headers` and every method. `Object.keys(reply)` lists only decorations and methods assigned on the reply.
- **`JSON.stringify(reply)`** gives `statusCode`, `headers` and `sent`, then decorations.
- **`Object.create(reply)`**, and `Object.create()` of that again, gives an object that acts on the reply: the status, headers and `sent` it sets, by method or by assignment, are the reply's, and its methods answer as the reply's.
- **A transparent `Proxy`** acts on the reply the same way: one with no traps, one whose `get` and `set` traps forward through `Reflect.get` and `Reflect.set` (with the receiver or without), an `Object.create()` of a proxy, and a proxy of an `Object.create()`.
- **Not supported: a `Proxy` whose `get` trap hides symbol-keyed properties, and a membrane** (a proxy that wraps every value it returns). Through one, `statusCode`, `sent` and every method read as `undefined`: a reply finds itself through a symbol-keyed property, which such a proxy hides or wraps. In 0.6.7, when every method was a closure of its own, these worked.
- **A spread and `Object.assign()`** (`{ ...reply }`) copy the reply's own enumerable properties: its decorations, methods assigned on it, and some symbol-keyed fields internal to core. The copy has none of the reply's methods and is not a reply.
- **`structuredClone(reply)`** gives a plain object with the reply's decorations, and throws a `DataCloneError` when one of them, or a method assigned on the reply, is a function. It is not a reply. (In 0.6.7 it always threw.)
- **Not supported: copying a reply's symbol-keyed properties onto another object.** A copy made by assignment does not act on the reply, and assigning to the property a reply holds itself in throws a `TypeError`.

### `request`, as a route sees it

- **Own properties and the prototype.** `method`, `url`, `headers`, `params`, `query` and `parsedBody` are own properties (as are `ip` and decorations). `cookies`, `signal`, `body`, `bodyUsed` and the body methods (`json()`, `text()`, `formData()`, `arrayBuffer()`, `blob()`, `clone()`) are on the request's prototype: reading, destructuring, `in` and `for...in` see them, and `Object.keys(request)`, `{ ...request }` and `JSON.stringify(request)` do not.
- **`structuredClone(request)`** does not give a request: its `headers` are a `Headers` object, which Node 22 and later refuse to clone (a `DataCloneError`), and which Node 20 clones as a plain object.
- **It is not a `Request`.** `new Request(request, init)` throws a `TypeError`. `new Request(request.url, request)` gives a `Request` with the request's method, headers and signal.
- **`request.clone()`** returns a `Request`: through `inject()`, and through `app.handle()` given a plain `Request`, a plain one. On `serve()` it is a `Request` subclass (`constructor.name` is `"NodeRequest"`, and `instanceof Request` holds) whose `signal`, and that of a `Request` built from it, aborts when the client disconnects.
- The request that an unmatched request's hooks and a not-found handler see is built as in 0.6.7, with everything an own property.

### Replacing `app.handle`

- `serve()` goes through `app.handle` whenever it is not the method `CelsianApp` defines: replaced on the instance, replaced on `CelsianApp.prototype`, or overridden in a subclass. It reads `app.handle` once per request and calls what it read, with the app as `this`.
- It answers what that returns: a `Response`, a thenable of one, or a promise of one, including a promise from another realm. A handle that throws or rejects is answered 500.
- Such a handle is given a `Request` whose `signal`, and that of a `Request` it builds from it with `new Request(request, init)`, aborts when the client disconnects.

### `request.signal`

- **Without a request timeout** (`requestTimeout: 0`), `request.signal` is the signal of the `Request` the app was given. On `serve()` that is the connection's.
- **With one** (the default, 30 seconds), it is a signal of its own. It aborts when the input signal aborts, with the input's reason, and when the timeout fires, with the 504 `HttpError` as its reason. The timeout never aborts the input signal.
- It aborts when the input does even when an earlier `abort` listener on the input calls `stopImmediatePropagation()`. That holds on Node 20.3 and later, Bun, Deno and Cloudflare Workers. On Node 20.0 to 20.2, which have no `AbortSignal.any()`, such a listener keeps the abort from `request.signal`.
- An `abort` event dispatched on an input signal that has not aborted (`signal.dispatchEvent(new Event("abort"))`) does not abort `request.signal`, which aborts with the real reason when the input does.
- On Node and Bun, `request.signal` aborts just after the input signal's own `abort` listeners have run: inside one of them, `request.signal.aborted` is still `false`. On Deno and Cloudflare Workers, `request.signal` is `AbortSignal.any()` of the input and the timeout's signal, and is already `true` there. (In 0.6.7 it was `AbortSignal.any()` everywhere: already `true` on Node 22 and later, and `false` on Node 20.)
- When the input signal aborted before the request reached the app, `request.signal` is already aborted, with the input's reason.
- **How long it lives.** A request's signal keeps following its input after the handler has returned, and the input keeps it alive for as long as the input lives, so a listener on `request.signal` alone still runs when the client disconnects while a streamed response is being sent. The exception is an input signal that several requests share (the same `Request` dispatched more than once): no request's signal is kept alive by it, so a long-lived signal never holds finished requests in memory, and a signal that only has listeners may be collected before they run. One that something else holds, such as a stream, still aborts with the input's reason.
- On `serve()`, a signal first read after the request was answered reports whether the client had gone by then.

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

`trustedOrigins` on `csrf()` admits a separate front-end origin, such as a dashboard at `https://app.example.com` calling `https://api.example.com`. Browsers label those requests `Sec-Fetch-Site: same-site` or `cross-site`, and they are accepted only when their `Origin` is listed. They still need a valid token.

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

`openapi.description` adds operation documentation; `openapi.parameters` merges
with schema-derived query/path parameters by `(in, name)`. Later explicit entries
override earlier/inferred fields while preserving unspecified fields. An explicit
`schema` replaces the entire earlier schema; path parameters always remain
`required: true`. Duplicate explicit entries follow the same last-entry-wins rule
and appear only once in the document. Omit `openapi.security` for public
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
