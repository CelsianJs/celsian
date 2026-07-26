# @celsian/rpc

Type-safe RPC procedures with middleware, schema validation, and OpenAPI generation for CelsianJS.

## Install

```bash
npm install @celsian/rpc
```

## Usage

```typescript
import { procedure, router, RPCHandler } from '@celsian/rpc';

const appRouter = router({
  greet: procedure.input(z.object({ name: z.string() })).query(({ input }) => `Hello, ${input.name}!`),
});
const rpc = new RPCHandler(appRouter);
rpc.mount(app); // serves /_rpc/* (pass a prefix to mount elsewhere: rpc.mount(app, '/api/rpc'))
```

`mount()` registers both `GET` and `POST` wildcard routes — the RPC client uses
GET for queries and POST for mutations. (Note: `CelsianApp` has no `.all()`
method.) If you prefer to register the routes yourself:

```typescript
app.get('/_rpc/*path', (req) => rpc.handle(req));
app.post('/_rpc/*path', (req) => rpc.handle(req));
```

## Security defaults

The handler ships with three defaults you should know about, because each one
can reject a request that used to succeed.

### 1. Non-GET requests must be `application/json`

`multipart/form-data`, `application/x-www-form-urlencoded`, and `text/plain` are
CORS-*simple* content types: a cross-origin `<form method="post">` reaches them
with the victim's cookies attached and **no preflight**. The `mutation → POST`
rule is not a defense, because the attacker's form also uses POST. Requiring
JSON forces a preflight, which a plain HTML form cannot satisfy.

Anything else gets `415 UNSUPPORTED_MEDIA_TYPE`. Procedures that genuinely take
file uploads opt in per procedure:

```typescript
const appRouter = router({
  uploadAvatar: procedure.allowFormData().mutation(async ({ input }) => {
    const file = (input as FormData).get('file');
    // ...
  }),
});
```

An opted-in procedure is only as safe as the origin check below (or an
app-level CSRF token), so opt in narrowly.

### 2. Cross-origin state-changing requests are rejected

Applied to every mutation and every non-GET request (a `query` is invokable over
POST, so the verb carries no security meaning on its own):

| Request | Result |
| --- | --- |
| `Origin` matches the request URL's origin | allowed |
| `Origin` listed in `allowedOrigins` | allowed |
| `Origin` present and unrecognized | `403 CROSS_ORIGIN_DENIED` |
| No `Origin`, `Sec-Fetch-Site: cross-site` or `same-site` | `403 CROSS_ORIGIN_DENIED` |
| Neither header (curl, server-to-server, native client) | allowed |

`same-site` is rejected because a sibling subdomain shares cookies with you.

```typescript
new RPCHandler(appRouter, {
  allowedOrigins: ['https://app.example.com'], // separate SPA host, or behind a proxy
  // originCheck: false,                        // opt out entirely (not recommended)
});
```

Set `allowedOrigins` when you sit behind a reverse proxy: the check compares
against `request.url`'s origin, which may not be your public origin.

### 3. Introspection is off in production

`/_rpc/openapi.json` and `/_rpc/manifest.json` list every procedure path
(including `admin.*` and `internal.*`) with full input/output JSON Schemas. They
are served before procedure lookup, so per-procedure `middlewares` never applied
to them. They now default to development-only and `404` otherwise —
indistinguishable from an unknown procedure.

```typescript
new RPCHandler(appRouter, {
  introspection: true, // "development" (default) | true | false
  introspectionMiddlewares: [
    async ({ ctx, next }) => {
      if (!isAdmin(ctx.request)) throw new HttpError(403, 'Forbidden');
      return next();
    },
  ],
});
```

### Logging

Pass the app logger so 5xx detail goes through its redaction, levels, and sinks
instead of raw `console.error`, which a client can amplify into log flooding:

```typescript
new RPCHandler(appRouter, { logger: app.log });
```

## Wire protocol notes

`decode()` never copies `__proto__`, `constructor`, or `prototype` out of a
payload, on any path — including `GET ?input=` and standalone `handle()` calls,
neither of which passes through `@celsian/core`'s body-parser scrub. It also
caps nesting at 32 levels; deeper payloads become a clean `400 PARSE_ERROR`.

`RegExp` values are deliberately decoded as **strings**, never reconstructed
into a `RegExp`, so untrusted wire data cannot deliver a ReDoS pattern.

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
