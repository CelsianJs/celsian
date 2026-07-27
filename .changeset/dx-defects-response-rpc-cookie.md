---
"@celsian/core": minor
"@celsian/rpc": minor
"@celsian/schema": minor
"@celsian/adapter-vercel": minor
---

Validate bare response schemas, make RPC and Valibot types infer, and derive the cookie `Secure` flag from the request.

Each of these was proven by executing the documented sample, not by reading it.

- **`schema.response: MySchema` now validates.** The bare spelling, the one that
  mirrors `schema.body` and `schema.querystring`, was ignored entirely: only
  `{ 200: MySchema }` did anything, so a route whose schema forbade extra keys
  happily returned `200 {"id":"1","leaked":"secret"}`. A bare schema now applies
  to every 2xx response. It is deliberately NOT treated as `default`, because a
  `default` entry also covers 4xx/5xx and would turn every 404 into a 500.
- **Response-schema lookup no longer reads the prototype chain.**
  `schemas[status] ?? schemas.default` picked up Zod's bound `.default()`
  METHOD, handed a function to the schema adapter, and 500'd with
  `SchemaError: Unsupported schema: received a function (bound default)`. The
  lookup is now guarded with `Object.hasOwn`.
- **BREAKING: RPC procedures infer their input, and `input<T>`'s type parameter
  changed meaning.** `input<T>(schema: unknown)` mentioned `T` nowhere in its
  parameter list, so there was no inference site and `T` always collapsed to
  `unknown`. The signature is now
  `input<TSchema>(schema: TSchema): ProcedureBuilder<InferOutput<TSchema>, TOutput>`.

  `T` used to be **the parsed type**; it is now **the schema type**. Any call
  that passes an explicit type argument, which is what 0.5.x documented and what
  `create-celsian` scaffolded, is now a compile error: the explicit argument
  pins `TSchema` to the parsed shape, so the schema no longer matches the
  parameter and `input` falls back to `unknown`.

  ```
  src/routes/rpc.ts(12,32): error TS2345: Argument of type 'TObject<{ name: TString; }>'
    is not assignable to parameter of type '{ name: string; }'.
  src/routes/rpc.ts(14,37): error TS18046: 'input' is of type 'unknown'.
  ```

  Migration: delete the explicit type argument. Dropping it is what makes
  inference work, and `input` ends up correctly typed rather than `unknown`.

  ```ts
  // 0.5.x
  procedure
    .input<{ name: string }>(Type.Object({ name: Type.String() }))
    .query(({ input }) => ({ message: `Hello, ${input.name}!` }));

  // 0.6.0
  procedure
    .input(Type.Object({ name: Type.String() }))
    .query(({ input }) => ({ message: `Hello, ${input.name}!` }));
  ```

  `.query()` / `.mutation()` additionally infer the procedure's output from the
  handler unless `.output()` pins it.
- **Typed RPC clients resolve to the procedure map instead of `never`.**
  `RPCClientProxy` matched handlers against `ctx: unknown` while
  `ProcedureDefinition` declares `ctx: RPCContext`; under `strictFunctionTypes`
  the contravariant parameter check failed and every procedure fell to the
  `never` branch, so a typed client had no callable members at all.
- **Valibot schemas infer.** `InferOutput` checked `StandardSchema`, `_output`,
  `_type` and `static`. Valibot 1.x carries its output type on `~types`, so
  every Valibot-typed route inferred `unknown` and reading `request.parsedBody`
  raised TS18046 despite runtime validation working. `~types` and
  `~standard.types` are now recognized.
- **`app.route({ url })` infers params.** `params` typed as `{ id: string }` for
  `app.post('/users/:id', ...)` but degraded to `Record<string, string>` for the
  equivalent `app.route()`, because `TypedRouteOptions` had no url generic
  feeding `ExtractRouteParams`.
- **Cookie `Secure` follows the request protocol.** It was hardcoded `true`, so
  on plain-HTTP development the browser accepted the `Set-Cookie` and then never
  sent the cookie back: login wrote a session that never returned and
  `clearCookie()` logout silently did nothing, both behind a 200. `Secure` is
  now derived from the request: `true` over HTTPS, `false` over plain HTTP to a
  non-routable host (loopback, RFC 1918, link-local, `.local`), and still `true`
  over plain HTTP to a routable host, with a one-time warning naming
  `x-forwarded-proto`. `NODE_ENV` is not consulted, since a missing env var is
  what caused the original defect. The CSRF plugin now shares this policy instead
  of exempting itself with its own `NODE_ENV` check.

  The host that decision is made against is the one the browser addressed, read
  from the `Host` header, and `x-forwarded-proto: https` alone is enough to
  force `Secure`. Both matter because the request URL is frequently built from
  the address the server BOUND to rather than the one the client typed: on Node,
  `serve()` composes `http://${host}:${port}`, and `host` is the wildcard
  `0.0.0.0` under `NODE_ENV=production`. Wildcard binds are therefore not
  treated as local. Deriving from the bind address instead would strip `Secure`
  from the session cookies of every production Node deployment.
- **`createVercelCronHandler` runs cron jobs.** It validated `CRON_SECRET` and
  then called `app.handle(request)`, so no `app.cron()` job ever ran and a
  correctly-configured Vercel cron got a 404: scheduled work silently never
  executed. It now runs the matching jobs and returns 500 with the failing job
  names so Vercel marks the invocation as failed. With no jobs registered it
  still falls through to the router, so route-based cron endpoints keep working.
- **405 responses carry an `Allow` header**, as RFC 9110 requires and as
  `docs/errors.md` already claimed.
- **`inject()` accepts `cookies`**, which `packages/core/README.md` documented
  but `InjectOptions` never had, so the key was silently dropped.
- **`trackedPool()` accepts pools that close with `end()`.** It bound
  `pool.close` unconditionally, so wrapping a node-postgres `pg.Pool`, the pool
  the README's own example uses, threw before running a single query.
