# @celsian/schema

## 0.6.3

## 0.6.2

## 0.6.1

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

## 0.5.5

## 0.5.4

### Patch Changes

- 74898eb: Fail loud instead of silently pretending to work (framework-wide silent-failure sweep):

  - **@celsian/schema**: `fromValibot()` now validates modern Valibot schemas (>=0.31, incl. 1.x) through the Standard Schema `~standard.validate()` contract. Previously it only tried the legacy `_parse`/`safeParse` methods -- which modern Valibot no longer exposes -- so every validation silently failed with a generic "Unknown valibot schema format" issue, rejecting valid input with no field-level detail. Async Valibot schemas now fail with a clear, explicit error instead of leaking a dangling Promise.
  - **@celsian/adapter-node**: the vestigial `nodeAdapter.buildEnd()` build hook now throws a clear not-implemented error directing callers to the runtime `serve()` export, instead of logging "Generated server entry" while writing nothing to disk.

## 0.5.3

## 0.5.2

## 0.5.1
