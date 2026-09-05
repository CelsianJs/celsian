# @celsian/rpc

## 0.6.2

### Patch Changes

- @celsian/schema@0.6.2

## 0.6.1

### Patch Changes

- @celsian/schema@0.6.1

## 0.6.0

### Minor Changes

- 509e696: Validate bare response schemas, make RPC and Valibot types infer, and derive the cookie `Secure` flag from the request.

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

- 0d3097c: Harden the RPC surface and align schema-adapter behavior.

  **@celsian/rpc**

  - `decode()` no longer performs a real prototype assignment from client input. `JSON.parse` keeps `__proto__` as an own enumerable property, so copying it into a plain object fired `Object.prototype.__proto__`'s setter and re-parented the decoded object: `Object.keys(input)` omitted the injected fields while `input.isAdmin` read `true`. `__proto__`, `constructor`, and `prototype` are now skipped on every path, including `GET ?input=` and standalone `RPCHandler.handle()`, neither of which reaches core's body-parser scrub.
  - `decode()` now enforces an explicit 32-level depth cap, including inside the nested `JSON.parse` of the `Set`/`Map` wire tags.
  - **Breaking:** non-GET requests now require `content-type: application/json`. `multipart/form-data`, `application/x-www-form-urlencoded`, and `text/plain` are CORS-_simple_, so a cross-origin `<form>` could post to any mutation with the victim's cookies and no preflight. Procedures that genuinely need form bodies opt in with `procedure.allowFormData()`.
  - **Breaking:** state-changing requests are rejected when `Origin` is cross-origin, or when `Sec-Fetch-Site` is `cross-site`/`same-site`. Configure with `allowedOrigins`, or disable with `originCheck: false`. Clients sending neither header (curl, server-to-server) are unaffected.
  - **Breaking:** `/_rpc/openapi.json` and `/_rpc/manifest.json` are no longer served in production by default. Control with `introspection: boolean | "development"`, and guard them with `introspectionMiddlewares` (per-procedure middleware never applied to these endpoints).
  - `RPCHandler` accepts a `logger`, so 5xx detail flows through the app logger instead of raw `console.error`.

  **@celsian/schema**

  - **Breaking:** the TypeBox adapter now strips properties the schema does not declare, matching Zod and Valibot. Previously the same logical schema passed unknown keys through only under TypeBox, so swapping libraries silently changed whether `db.user.update({ data: validated })` was a mass-assignment hole. Opt out with `fromTypeBox(schema, { stripUnknown: false })` or `fromSchema(schema, { typebox: { stripUnknown: false } })`.
  - `InferOutput` now understands TypeBox's `static` carrier. TypeBox is what `create-celsian` scaffolds by default, and every TypeBox-typed route and procedure previously inferred `unknown`.
  - The "unsupported schema" error now reports what it actually received instead of a generic sentence.

### Patch Changes

- 0042f48: fix(schema,core,rpc): generate real JSON Schema for Zod and Valibot in OpenAPI

  OpenAPI generation was materially broken for the two schema libraries nearly
  every example uses.

  - `@celsian/schema` now converts Zod (v3 and v4) and Valibot schemas to JSON
    Schema by reading their internal representations, with no new dependency and
    without importing either optional peer at runtime. Both adapters previously
    answered `{ type: "object" }` for every schema, so a documented request body
    had zero documented fields.
  - The OpenAPI plugin runs schemas through the adapters before any structural
    guess. Valibot object schemas natively carry `type: "object"`, so the previous
    `"type" in schema` shortcut published Valibot's raw internal AST (`kind`,
    `expects`, `entries`, `~standard`) into the document verbatim.
  - A bare (non-status-keyed) `schema.response` is now recognised with the same
    `isStatusKeyedResponseMap` guard the runtime validator uses. It used to be
    iterated as a status map, so `response: z.object({...})` emitted roughly 29
    responses named after the schema instance's own methods (`spa`, `_def`,
    `parse`, `safeParse`, `refine`, …), producing an invalid document.
  - `schema.querystring` now reaches the spec as query parameters for all three
    libraries; it produced nothing whenever the schema converted to a property-less
    object.
  - `RPCHandler.generateOpenAPI()` inherits the same fix, and a query procedure's
    `input` parameter now documents its real shape via `content` instead of an
    uninformative `schema: { type: "string" }`.

- 0042f48: Stop shipping broken source maps, and fix the `@celsian/cli` package shape.

  **Source maps are no longer published.** Every package ships `files: ["dist"]`
  and deliberately does not ship `src`, but the build emitted `.js.map` and
  `.d.ts.map` files whose `sources` is `["../src/index.ts"]`, a path that is never
  in the tarball. Consumers got a debugger that could not step into anything and a
  "Go to Definition" that landed on a missing file, while the maps carried real
  weight: `@celsian/core`'s tarball drops from 172.5 kB to 113.0 kB (-34.5%) with
  them removed, 30.1 kB of which was `app.js.map` alone. Without a map, tooling
  falls back to the emitted `.js` / `.d.ts`, which is correct rather than broken.
  Shipping `src` instead would have made the maps work at the cost of roughly
  doubling every tarball for a debugging affordance the project has never offered.

  **`@celsian/cli` is declared as the bin-only package it is.** Its `main` and
  `types` pointed at `dist/index.js`, which is the shebang'd CLI entry, so
  `await import("@celsian/cli")` **executed the CLI** and printed the help banner
  as a side effect of importing it. It also declared `"sideEffects": false`, which
  was untrue of that same entry. `main`, `types` and `sideEffects` are removed and
  no `exports` map is added: the package is consumed through its `celsian` binary,
  and importing it now fails cleanly instead of running a program.

  **`celsian` and `create-celsian` declare `publishConfig.access: "public"`**, the
  only two publishable packages that were missing it.

  **`@celsian/adapter-bun` and `@celsian/adapter-deno` widen their `@celsian/core`
  peer range** from the exact current version to `>=0.5.0 <1.0.0`. An exact peer
  pin meant every consumer had to match the adapter's core version to the patch,
  and it also forced the release tooling to treat every minor as a breaking change
  for those two packages. See `.changeset/README.md`.

- e75e588: Fix the public type surface exposed by turning the typecheck gate on over test files.

  **@celsian/core**

  - `CelsianRequest.cookies` is now declared. It is defined on every request by the app itself, not by a plugin, but it was reachable only through the plugin index signature, so `req.cookies.session` arrived as `unknown` and every caller had to cast.
  - The dead-letter and task-durability types are now exported: `DeadLetterCapableQueue`, `DeadLetterEntry`, `TaskFailure`, `TaskFailureInfo`, `ServerlessCronRuntime`, plus the `DEFAULT_VISIBILITY_TIMEOUT`, `DEFAULT_TASK_TIMEOUT`, and `detectServerlessCronRuntime` values. Implementing a custom queue backend previously required re-declaring them by hand.

  **@celsian/queue-redis**

  - `QueueMessage`, `TaskFailure`, and `DeadLetterEntry` are exported. `TaskFailure` and `DeadLetterEntry` were structural mirrors of core's types, kept locally only because core did not export them; they are now the real types re-exported from core, so a backend can no longer drift from the interface it implements.

  **@celsian/schema**

  - The Zod adapter accepts real Zod 4 schemas again. Its `ZodIssue.path` was declared `(string | number)[]` while Zod 4 produces `PropertyKey[]`, so `z.object(...)` did not satisfy `fromZod`'s parameter type. Symbol path segments are normalized to strings on the way out, leaving the published `SchemaIssue.path` contract unchanged.
  - `fromZod` also accepts ordinary Zod-shaped objects again. Its result type was a union discriminated on the literals `true`/`false`, which no plain function return ever has (TypeScript widens `success` to `boolean`), so only Zod's own types could satisfy it. A failed parse that carries no error object now reports that instead of throwing on a missing property.

  **@celsian/rpc**

  - `createRPCClient<any>()` is usable again. `any` satisfied every branch of the client's conditional type at once, so the result was a union of all three branches and no property access on the client compiled.

- d668e87: Security: gate WebSocket upgrades on plugin hooks, close the file-serving race, harden cache keys

  Findings from an independent adversarial re-audit of the hardening sprint. Each
  one was proven with an executed proof of concept and now has a regression test.

  **WebSocket upgrades skipped every plugin-registered hook** (`@celsian/core`,
  also affects `@celsian/adapter-bun`). After the hook-resolution rewrite, the
  upgrade path read `rootContext.hooks.onRequest`, which holds only hooks added via
  `app.addHook`. Anything contributed by `app.register(plugin)` lives on a child
  context and was invisible there, so `csrf()`, `rateLimit()`, and auth plugins
  registered the documented way did not gate handshakes: an HTTP request got 401
  while the WebSocket handshake got 101. Upgrades now resolve the root scope
  through the encapsulation chain, so un-prefixed plugin hooks apply.

  New public accessors replace the internal reach-throughs that caused this:
  `app.getUpgradeHooks()`, `app.hasStructuredLogger()`, and
  `pluginContext.getRequestDecoration(name, { scope })`.

  **TOCTOU race in `reply.sendFile()` / `reply.download()`** (`@celsian/core`). The
  containment check returned a resolved path string that was then re-opened by
  name, so an attacker able to write inside the served root could swap the leaf for
  a symlink in that window (measured: 170 of 2000 concurrent requests returned
  content from outside the root). Files are now opened once with `O_NOFOLLOW` and
  read from that handle; a symlinked leaf is a 403, a missing file a 404.
  `allowSymlinks: true` is unchanged.

  **Unknown-tag escape hatch in the RPC wire decoder** (`@celsian/rpc`). An
  unrecognised `__t` tag returned the raw `JSON.parse` object, skipping the
  `__proto__`/`constructor`/`prototype` scrub entirely, so any payload could opt
  out of it by inventing a tag. Unknown tags are now rebuilt like plain objects.

  **Cache poisoning through host-rewrite headers outside the denylist**
  (`@celsian/cache`). `forwarded` (the RFC 7239 standard header),
  `x-forwarded-scheme`, `x-forwarded-port`, `x-forwarded-prefix`,
  `x-forwarded-uri`, `x-forwarded-ssl`, `x-http-host-override`, `x-original-host`,
  and `x-original-uri` are now partitioned eagerly alongside the existing six. A
  denylist cannot be complete, and the README now says so explicitly: any request
  header a handler reflects into a response must be listed in `varyHeaders`.

  **Behaviour change:** the default cache key now includes the SCHEME
  (`GET:https//example.com:/data`), so `http://x.app/data` and `https://x.app/data`
  no longer share an entry. This invalidates entries written by earlier versions,
  which is correct for a safety boundary. `invalidate()` still accepts the
  host-less `GET:/data` form.

  **Ambient JWT guard failed open to an arbitrary realm** (`@celsian/jwt`). A route
  outside every realm's scope using a no-argument `createJWTGuard()` authenticated
  against whichever realm registered last, so tenant B's token was accepted on a
  route that belongs to no tenant. With exactly one realm registered the fallback
  is unchanged; with two or more it now throws an actionable error naming
  `jwt(...).guard()` and `createJWTGuard({ secret })`.

  **Behaviour change:** an unbound `createJWTGuard()` on a route outside every
  realm now throws instead of silently picking a realm, on apps with more than one
  realm registered.

  **RPC content-type check was a substring match** (`@celsian/rpc`). `Content-Type:
text/plain; charset=application/json` is CORS-simple but passed as JSON,
  defeating the preflight property the JSON requirement exists to guarantee. The
  MIME essence is now parsed and compared exactly, accepting `application/json` and
  any `+json` suffix (and, newly, mixed-case spellings).

- Updated dependencies [509e696]
- Updated dependencies [0042f48]
- Updated dependencies [0042f48]
- Updated dependencies [0d3097c]
- Updated dependencies [e75e588]
  - @celsian/schema@0.6.0

## 0.5.5

### Patch Changes

- @celsian/schema@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies [74898eb]
  - @celsian/schema@0.5.4

## 0.5.3

### Patch Changes

- @celsian/schema@0.5.3

## 0.5.2

### Patch Changes

- 05eb2b4: Security hardening across rate-limit, rpc, and jwt:

  - **@celsian/rate-limit (SECURITY, behavior change):** with `trustProxy: true`, the default key is now taken from X-Forwarded-For counting `trustedProxyHops` (new option, default `1`) from the RIGHT instead of using the leftmost entry. The leftmost XFF value is client-supplied -- rotating it per request fully bypassed rate limiting and flooded the store with unique keys. With one trusted proxy the keyed IP is the last entry (what your proxy appended); set `trustedProxyHops` to your actual proxy depth, or keep using a custom `keyGenerator`. Note: deployments behind multiple proxies that relied on the old leftmost behavior will now key a different IP -- this is intentional.
  - **@celsian/rate-limit (SECURITY):** `MemoryRateLimitStore` now enforces a max-keys cap (`maxKeys` option, default `100_000`, also exposed on `rateLimit()` options) with expired-first/oldest-first eviction so spoofed-key floods can no longer exhaust memory.
  - **@celsian/rate-limit (fail-closed):** `rateLimit()` now throws a `CelsianError` at registration when `window` or `max` is missing/NaN/non-positive. Previously an invalid `window` (e.g. passing `windowMs`) made every bucket's `resetAt` NaN and silently disabled rate limiting (fail open).
  - **@celsian/rpc (SECURITY):** unexpected (5xx-equivalent) procedure errors no longer leak raw `error.message`/`error.code` to clients when `NODE_ENV`/`CELSIAN_ENV` is `production` -- they return a generic `INTERNAL_ERROR` body (mirroring `@celsian/core`'s error-handler sanitization) and are always logged server-side. Full detail is preserved in development, and intentional HTTP-style errors (`statusCode < 500`) pass through unchanged.
  - **@celsian/rpc:** new `rpc.mount(app, prefix?)` helper registers both `GET` and `POST` wildcard routes on a Celsian app (the client uses GET for queries and POST for mutations). The README previously documented `app.all(...)`, which `CelsianApp` does not have; `mount()` is now the documented primary path.
  - **@celsian/jwt:** registering with an HS\* secret shorter than 32 bytes now emits a `console.warn` (non-breaking) -- short HMAC secrets can be brute-forced offline from any captured token.
  - @celsian/schema@0.5.2

## 0.5.1

### Patch Changes

- @celsian/schema@0.5.1
