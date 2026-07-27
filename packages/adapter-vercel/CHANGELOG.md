# @celsian/adapter-vercel

## 0.6.1

### Patch Changes

- @celsian/core@0.6.1

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

### Patch Changes

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

- Updated dependencies [408f4af]
- Updated dependencies [a1ef683]
- Updated dependencies [509e696]
- Updated dependencies [509e696]
- Updated dependencies [1a066de]
- Updated dependencies [0042f48]
- Updated dependencies [0042f48]
- Updated dependencies [1e92ae8]
- Updated dependencies [1e92ae8]
- Updated dependencies [e75e588]
- Updated dependencies [7e85b5a]
- Updated dependencies [d668e87]
  - @celsian/core@0.6.0

## 0.5.5

### Patch Changes

- Updated dependencies [d574a13]
  - @celsian/core@0.5.5

## 0.5.4

### Patch Changes

- @celsian/core@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies [a60b3e4]
  - @celsian/core@0.5.3

## 0.5.2

### Patch Changes

- 05eb2b4: Serverless adapter fidelity and edge-compatibility fixes:

  - **adapter-lambda**: forward API Gateway v2 `event.cookies` as the `cookie` request header (handlers previously saw no cookies); pass base64-encoded bodies through as raw bytes instead of corrupting binary payloads via utf-8 decoding; support API Gateway v1 (REST API) and ALB events with shape detection, multiValueHeaders/multiValueQueryStringParameters merging, and v1/ALB response formats (including `multiValueHeaders` set-cookie handling).
  - **adapter-vercel**: remove the module-level `node:crypto` import that broke edge bundling (`esbuild --platform=neutral`); the cron handler's timing-safe secret comparison now uses Web Crypto (`crypto.subtle`), keeping `createVercelEdgeHandler` bundleable for edge runtimes.
  - **adapter-cloudflare**: `createCloudflareHandler(app)` now also returns a `scheduled` handler that bridges Cloudflare Cron Triggers to `app.cron()` jobs (matching by cron expression, falling back to all jobs when a single trigger drives them); existing `fetch`-only usage keeps working.
  - **adapter-bun**: document that `server.upgrade()` runs before route hooks (JWT guards/rate limiting do not apply to WS upgrades) and show the `open`-handler auth pattern.
  - **adapter-node**: fix stale `then.config.ts` reference in the README (now `celsian.config.ts`).

- Updated dependencies [05eb2b4]
  - @celsian/core@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [0c69589]
  - @celsian/core@0.5.1

## 0.3.19

### Patch Changes

- Updated dependencies [dec80a7]
  - @celsian/core@0.4.0

## 0.3.16

### Patch Changes

- Updated dependencies
  - @celsian/core@0.3.16

## 0.3.1

### Patch Changes

- Updated dependencies [5d0dc35]
  - @celsian/core@0.3.3
