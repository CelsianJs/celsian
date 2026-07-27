# @celsian/core

## 0.6.1

### Patch Changes

- @celsian/schema@0.6.1

## 0.6.0

### Minor Changes

- 408f4af: Resolve hooks and decorations through the encapsulation context chain

  Route hook chains were snapshotted at `addRoute()` time and read from the root
  context at request time, so plugin `onRequest`/`preHandler` hooks never ran,
  hooks added after a route was registered were ignored, plugin-scoped
  `decorateRequest` was a no-op, and `onSend`/`onResponse` were hoisted onto every
  ancestor and fired outside their prefix.

  Hook chains and request/reply decorations are now resolved lazily from the
  route's context chain and memoized, so registration order no longer matters:

  - `app.register(csrf())` (or any plugin registered without a prefix) now guards
    routes declared on the app, for every hook type. Un-prefixed plugins are
    app-wide middleware; a plugin registered **with** a prefix keeps its hooks
    inside that prefix and no longer leaks onto sibling routes.
  - `preParsing`, `preValidation` and `onError` registered inside a plugin now run
    (previously only root-context ones did).
  - `schema.response` is now enforced: a mismatch returns a generic 500 and logs
    the detail server-side. Opt out with `createApp({ validateResponses: false })`.
  - Validated `querystring`/`params` output now reaches `request.query` and
    `request.params` (`parsedQuery` remains an alias), so handlers no longer read
    the raw, uncoerced input.
  - Route handlers may return serializable data, not just `Response`, and
    `schema.body`/`schema.querystring` now actually type `parsedBody`/`parsedQuery`
    on `app.get/post/put/patch/delete` and `app.route`.
  - Synchronous throws in fire-and-forget (`onResponse`) hooks are logged instead
    of silently swallowed.

- a1ef683: Make the durable task queue actually durable.

  - **Dead-letter queue.** Jobs that exhaust their retries are moved to a dead-letter queue with the final error and the full attempt history, instead of being logged and acked away. Both the in-memory and Redis backends implement `deadLetter`, `listDeadLetters`, `redriveDeadLetter`, `redriveDeadLetters`, `purgeDeadLetters` and `deadLetterSize`. New `onFailure` and `onDeadLetter` worker hooks report every failed attempt and every dead-lettered job.
  - **Atomic delayed-message promotion (Redis).** `promoteDelayed` used `pipeline()`, which batches but is not atomic, so every concurrent worker duplicated each delayed retry, and removal by score range silently deleted messages pushed into the window. It is now a single Lua script that removes by member and gates promotion on `ZREM`.
  - **Lease tokens and heartbeats.** Each delivery gets a distinct lease token; `ack`, `nack` and `extend` only affect the delivery that owns the lease, so a slow worker can no longer complete the job another worker has taken over. Tasks receive `ctx.heartbeat()` and the worker heartbeats automatically.
  - **At-least-once in-memory backend.** `MemoryQueue` reclaims and redelivers messages whose lease expires rather than losing them, and its durability limits are documented honestly in code.
  - **Task timeouts.** Tasks now default to a timeout below the queue's visibility timeout, the timer is always cleared, and a timed-out task is cancelled through `ctx.signal` instead of merely losing a race while continuing to run. Registering a task whose timeout is not below the visibility timeout throws unless `longRunning: true` is set.
  - **Loud shutdown.** A worker that hits its drain deadline reports exactly how many jobs it abandoned, on both the logger and `console.error`.
  - **Serverless cron warning.** `CronScheduler.start()` detects Cloudflare Workers, AWS Lambda, Vercel, Netlify, Deno Deploy and Cloud Run, and warns that its in-process timer will never fire there, naming the platform-native alternative.

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

- 509e696: Confine file serving, harden router paths, and tighten CSRF, SSE, uploads, cookies and redirects.

  Sprint Track 2 shipped these without a changeset, so none of them reached the
  generated changelog. Every item below can reject a request that previously
  succeeded, so read this before upgrading.

  - **`reply.sendFile()` / `reply.download()` are confined to a root.** The
    resolved path must stay inside `options.root` (default: the process CWD).
    An escape is a 403, a missing file is a 404. Symlinks pointing outside the
    root are refused unless `followSymlinks: true` is passed. Previously any path
    a handler produced was served, so a handler interpolating user input into a
    path served arbitrary files.
  - **`reply.redirect()` validates its target.** Protocol-relative targets
    (`//evil.example`) and absolute URLs to hosts outside `options.allowedHosts`
    are rejected with a 400 instead of becoming an open redirect. Relative paths
    are unaffected.
  - **Aliased request paths no longer resolve.** `//admin`, `/./admin` and
    `/admin//` used to reach the same handler as `/admin`, which lets a request
    walk around an upstream gateway rule written against the canonical path. They
    are now 404s. Plain trailing-slash tolerance is preserved and configurable via
    the router's `ignoreTrailingSlash` (default `true`, matching pre-0.6.0).
  - **New `strictParams` router option.** With it enabled, a route param that
    percent-decodes to a value containing `/`, `\` or NUL is a 400. `%2F` inside a
    single segment decodes back into a slash, which is how a "one segment" param
    turns into a traversal payload. Off by default because runtimes differ in
    whether they pre-decode the path.
  - **Malformed percent-encoding in a matched param is a 400.** `MALFORMED_URI`,
    rather than an uncaught `URIError` crashing the request.
  - **Duplicate and conflicting route registrations throw.** Registering the same
    method and path twice used to silently replace the first handler. Two sibling
    routes declaring different param names at the same position (`/a/:id` and
    `/a/:slug`) also throw, because only the first name was ever populated and the
    second arrived `undefined` at runtime.
  - **Cookies default to `Secure`.** `serializeCookie()` no longer infers
    "not production" from `NODE_ENV`, which is routinely unset in containers and
    shipped session cookies with no `Secure` flag. See the follow-up release note
    for how this default now derives from the request protocol.
  - **CSRF tokens are bound to the session.** A token is re-issued whenever the
    session id changes, so a token minted before login is useless after it.
    State-changing requests announcing themselves as cross-site via
    `Sec-Fetch-Site` or a mismatched `Origin` are rejected with a 403 before the
    token is even checked.
  - **SSE fields are sanitized.** CR/LF is stripped from `event:` and `id:`, and
    `retry:` only emits finite numbers. A newline smuggled into any of them could
    close the frame and forge extra events into a victim's stream.
  - **Uploads enforce limits and verify content.** `maxFiles` and per-file size
    limits return 413, a MIME allowlist returns 415, and file bytes are sniffed
    for magic-byte signatures so a declared content type that contradicts the
    content is refused. `file.filename` is now a sanitized basename with path
    separators, NUL, control characters and leading dots removed; the raw,
    attacker-controlled value is preserved on a separate field.
  - **ETags use SHA-256 truncated to 128 bits.** The previous 32-bit
    non-cryptographic hash collided easily, and an ETag collision serves a 304 for
    content that changed.
  - **413 responses name the limit.** The body reports the byte limit and the
    config key that raises it, instead of a bare "Payload Too Large".
  - **Swagger UI assets are pinned with subresource integrity.** Exact version
    plus `sha384` SRI hashes, so a compromised CDN cannot inject script into the
    docs page. `/docs` remains unauthenticated by default and the option docs now
    say to gate it in production.

- 1a066de: Secure WebSocket upgrades, wire Bun WebSockets, remove the unimplemented Node build adapter.

  **@celsian/core, WebSocket upgrades are now gated (security fix).**
  `serve()` accepted every WebSocket handshake that matched an `app.ws()` path: no
  Origin check, and no `onRequest` hook ever ran. Because WebSocket handshakes are
  exempt from the same-origin policy and CORS, any page could open an authenticated
  socket against a cookie-session app (cross-site WebSocket hijacking). Upgrades now
  run an Origin allow-list (same-origin by default), the app's root `onRequest`
  hooks (so auth guards and rate limiters apply), a per-IP connection cap
  (default 64), and a 1 MiB `maxPayload` in place of the `ws` default of 100 MB.
  New `serve()` options: `allowedOrigins`, `allowMissingOrigin`, `skipUpgradeHooks`,
  `maxPayload`, `maxConnectionsPerIP`. New exports: `authorizeWSUpgrade`,
  `checkWSOrigin`, `WSConnectionLimiter`.

  BREAKING: cross-origin and Origin-less handshakes that previously succeeded are
  now rejected with 403. Set `allowedOrigins` for cross-origin browser clients and
  `allowMissingOrigin: true` for non-browser clients.

  **@celsian/core, process safety and logging.** `serve()` installs
  `unhandledRejection`/`uncaughtException` handlers that log with full context,
  drain in-flight requests, and exit non-zero (opt out with
  `handleFatalErrors: false`), and detaches all of its process listeners on close.
  The startup line is no longer printed twice: the plain-text line is emitted only
  when the structured logger is disabled. `ws` is now declared as an optional peer
  dependency, and the missing-`ws` warning names the exact install command.

  **@celsian/adapter-bun, WebSocket support now actually works.**
  `createBunServeOptions()` never set the `websocket` key, so `server.upgrade()`
  could not succeed and the documented Bun WebSocket support was inoperative. The
  adapter now provides a full Bun `websocket` handler (`open`/`message`/`close`/
  `drain`) bridged to the app's WS registry, applies the same upgrade gate as core,
  and returns `undefined` after a successful upgrade as Bun requires.

  BREAKING: `BunFetchHandler` may now return `undefined`; `createBunHandler` takes
  an optional options argument.

  **@celsian/adapter-node, removed the unimplemented build adapter.**
  The default export (`buildEnd()`, `entryTemplate`) targeted a `@celsian/build`
  pipeline that does not exist; `buildEnd()` could only throw. It has been removed
  along with the dead server-entry template, and the README no longer documents it
  or a `@celsian/build` peer dependency. `writeWebResponse()` now writes multiple
  `Set-Cookie` headers as separate lines instead of one comma-joined value.

  BREAKING: the default export is now `serve`; `ThenAdapter`, `buildEnd()`, and
  `entryTemplate` are gone. Use `serve(app, options)`.

  **@celsian/adapter-deno** throws `CelsianError` instead of a bare `Error` when the
  Deno runtime is absent.

- 1e92ae8: Close an open redirect, a static-file symlink escape, an upload path escape, and two rate-limit key bypasses.

  - **Open redirect via TAB, LF and CR.** `safeRedirectLocation` normalized `\` to
    `/` and rejected `//`, but a URL parser also DELETES ASCII tab, newline and
    carriage return before parsing. `/<TAB>/evil.com` passed validation and was
    emitted as a `Location`, and the browser resolved it to `https://evil.com/`.
    Those characters are now stripped before validation, to a fixed point.
  - **`serve({ staticDir })` followed symlinks out of its root.** An earlier change
    hardened `reply.sendFile()` with `O_NOFOLLOW` and left the static path on a
    lexical check only, so the same process refused a symlinked file through
    `sendFile` (403) and served it through `staticDir` (200). Both paths now share
    one confinement helper, so they cannot drift apart again. Note a symlink INSIDE
    the served root is now also refused.
  - **Upload filenames could escape the upload directory.** `sanitizeFileName`
    stripped leading dots BEFORE trimming whitespace, so a leading space shielded
    the dots and the trim then re-exposed them: `" .."` came back as `".."`, which
    joined onto the upload directory escapes it. Trimming and dot-stripping now run
    as a loop to a fixed point, and `.`, `..`, empty results, Windows reserved
    device names and trailing dots are all rejected.
  - **`reply.redirect()` returned 500 on control characters**, against a docblock
    promising a 400; **`reply.download()` reported 404 for files that exist** when
    the filename was not Latin-1, and did not basename the filename or emit an RFC
    6266 `filename*`.
  - **The cookie `Secure` warn-once set was unbounded** and keyed on the
    client-controlled `Host` header, so spoofed hosts grew it without limit.
  - **The rate limiter handed its bucket key to the client.** When the forwarded
    chain was shorter than the configured hop count, the clamp selected the
    leftmost, fully client-supplied entry. That gave unlimited quota by rotating
    one header, and let an attacker exhaust a DIFFERENT user's bucket. It now fails
    closed. Separately, the key was raw header text, so `1.2.3.4`, `01.02.03.04`,
    `::ffff:1.2.3.4` and `1.2.3.4:<port>` each got their own bucket; keys are now
    canonicalized, and over-long custom keys are hashed rather than sharing one
    bucket.

- 1e92ae8: Resolve the request's real authority, and resolve hooks for the matched scope.

  Several separately-reported security bugs turned out to share two root causes.

  **`request.url` carried the address the server BOUND to, not the host the client
  addressed.** `serve()` composes `http://${host}:${port}`, and `host` is the
  wildcard `0.0.0.0` under `NODE_ENV=production`. The URL that applied
  `x-forwarded-proto` and the `trustedHosts`-gated host rewrite was computed and
  then passed to the request builder as a parameter that was never read, so:

  - `trustProxy` and `trustedHosts` were dead code. `x-forwarded-proto` was never
    applied and the host-header-injection allowlist never ran, both contrary to
    their documentation.
  - The CSRF origin check compared `Origin` against the bind address, which
    INVERTED the control: a legitimate same-origin browser POST was rejected 403
    while a request with no `Origin` header passed.
  - The shared response cache keyed every tenant to the same `0.0.0.0` authority,
    so one tenant's response body was served to another.

  `request.url` now reports the host the client addressed, taken from the `Host`
  header, with `x-forwarded-proto` and an allowlisted `x-forwarded-host` applied
  under `trustProxy`. A `Host` value that is not a bare authority (userinfo, a
  path, a query) is ignored in favour of the transport authority. The cache
  additionally keys on `Host` directly, so it is correct independently of this.

  **Hook resolution stopped at the root scope.** A plugin registered WITH a prefix
  lives in a child scope and was invisible to two gates:

  - WebSocket upgrades were not gated by auth hooks from prefixed plugins. The
    identical plugin rejected an unauthenticated HTTP request with 401 and accepted
    the unauthenticated handshake with 101, then delivered its payload.
  - The 405 `Allow` header enumerated the methods of routes sitting behind an
    encapsulated guard, disclosing a route surface the caller was not authorized to
    see.

  Both now resolve hooks for the path actually being served.

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

- 7e85b5a: Report the client's host to WebSocket handlers, not the bind address.

  The upgrade gate already resolved the real host, so this was never an
  authentication bypass. But the `CelsianRequest` handed to `handler.open` was
  still built from the URL composed out of the address the server BOUND to, which
  `serve()` sets to the wildcard `0.0.0.0` under `NODE_ENV=production`. Any handler
  that dispatches on host, which is how a multi-tenant app routes, saw
  `http://0.0.0.0:3000/chat` for every tenant:

  ```
  before: {"urlSeenByHandler":"http://0.0.0.0:5701/chat"}
  after:  {"urlSeenByHandler":"http://app.example.com/chat"}
  ```

  The other adapters were checked and are unaffected: `adapter-cloudflare`,
  `adapter-lambda`, `adapter-deno` and `adapter-vercel` all dispatch through
  `app.handle()`, which resolves the host already.

- Updated dependencies [509e696]
- Updated dependencies [0042f48]
- Updated dependencies [0042f48]
- Updated dependencies [0d3097c]
- Updated dependencies [e75e588]
  - @celsian/schema@0.6.0

## 0.5.5

### Patch Changes

- d574a13: Prevent cross-user response disclosure by bypassing the shared response cache
  for credentialed requests, partitioning reflected CORS responses by Origin,
  refusing `no-cache`, zero-age, and private responses, and storing only `Vary`
  responses whose request fields are represented in the cache key. Remove the module-global
  JWT guard fallback so no-argument guards resolve secrets and algorithms only
  from the current app's request.
  - @celsian/schema@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies [74898eb]
  - @celsian/schema@0.5.4

## 0.5.3

### Patch Changes

- a60b3e4: Production-readiness DX fixes and dependency maintenance (0.5.3).

  - **@celsian/core (fail-loud config):** `loadConfig()` no longer swallows a broken `celsian.config.*` with a bare `catch`. A genuinely absent config still falls back to defaults, but a config that exists and fails to load (syntax/runtime error, or a missing import it depends on) now throws the new exported `ConfigLoadError` naming the file and cause. `serve()` surfaces it instead of silently binding defaults -- fixing the "why won't my config apply" black hole where a typo in the config left the server on port 3000 with no diagnostic.
  - **@celsian/cli (`celsian dev`):** checks the entry file exists before spawning `tsx`, printing `Entry file not found: <entry>` plus usage (mirroring `celsian routes`) instead of a raw "Cannot find module" stack trace on first run.
  - **@celsian/cli (`celsian generate rpc`):** now scaffolds a mountable, type-correct starting point -- wrapped in `router()`, exported as a registerable `PluginFunction` that calls `new RPCHandler(...).mount(app)`, with `.input(schema)` guidance -- instead of a bare object that had no path to a live endpoint and destructured an always-`undefined` `input`.
  - **@celsian/jwt:** bump `jose` `5.10.0` → `6.2.2` (major). No API changes; sign/verify/expiry/algorithm selection and cross-app guard isolation are all covered by the existing jwt test suite under jose 6.
  - **@celsian/ws-redis, @celsian/queue-redis:** bump `ioredis` `5.9.3` → `5.11.1` (minor).
  - @celsian/schema@0.5.3

## 0.5.2

### Patch Changes

- 05eb2b4: Core hardening (0.5.2).

  **Behavior changes -- read before upgrading:**

  - **Production now binds `0.0.0.0`.** `serve()` previously always bound `localhost`
    (IPv6 `::1`), making the server unreachable from a Docker/Fly/Railway port map.
    It now binds `0.0.0.0` when `NODE_ENV=production` (still `localhost` in dev),
    after honoring an explicit `host` option or `HOST` env var. If you relied on
    loopback-only binding in production, set `host`/`HOST` to `127.0.0.1` explicitly.
  - **CSRF `excludePaths` now match by path segment.** An entry like `/api` previously
    matched only the exact path `/api`; it now also exempts `/api/...` (but not
    `/apix`). This widens existing exclusions -- review your `excludePaths` lists.

  **Also fixed:** options-object route handlers (`app.post(url, { schema, handler })`),
  serverless-safety warnings now surface through the default (noop) logger, CORS
  `Vary: Origin` on reflected origins, `bodyLimit` enforced for custom content-type
  parsers, WS dependency/runtime warnings (Node `ws` install hint; Bun points at
  `@celsian/adapter-bun`), `serve()` resolves only after listening and reports the
  OS-assigned port, binary `reply.send()` emits `application/octet-stream`, cron
  double-fire guard, explicit server request/headers timeouts, and umbrella
  re-exports (csrf, etag, db analytics).

  - @celsian/schema@0.5.2

## 0.5.1

### Patch Changes

- 0c69589: Performance: faster Node request/response path (no behavior change).

  - Buffered responses from `reply.json()/send()/html()` and the auto-serializer now write in a single `res.writeHead()+res.end()` with an explicit `Content-Length`, instead of draining a `ReadableStream` reader. (~+11–38% req/s across scenarios; JSON 41.4K→51.9K req/s, ~74% of Fastify.)
  - `buildRequestFast()` builds the per-request wrapper from a shared prototype, eliminating 6 `.bind()` and 2 `Object.defineProperty` calls per request (~10× cheaper to construct).
  - `nodeToWebRequestFast()` passes Node's header record straight to `Request` in the common all-string case.

  Also: honest, isolated memory benchmark (`benchmarks/mem.ts`) replacing the previous shared-process RSS-delta measurement, which was order-biased and overstated memory ~50× for whichever framework ran first. Retained heap is on par with Express and below Fastify. Added `benchmarks/soak.ts` (sustained-load leak check). Multi-runtime serving verified on Node, Bun, Deno, Cloudflare Workers, and AWS Lambda.

  - @celsian/schema@0.5.1

## 0.4.0

### Minor Changes

- dec80a7: Production hardening release: security fixes (rate-limit IP spoofing, JWT secret scoping, session regeneration, lambda proto validation, error stack guards), app.ts decomposition into body-parser and error-handler modules, file upload plugin, Bun and Deno adapters, ws-redis distributed WebSocket, deploy command with platform auto-detection, integration and stress tests, Fastify migration guide.

## 0.3.16

### Patch Changes

- Apply registered security headers to framework-generated 404 and 405 responses so global security middleware covers unmatched routes as documented.

## 0.3.3

### Patch Changes

- 5d0dc35: Security, reliability, and DX improvements from comprehensive product audit.

  **Security**: Rate limiter uses rightmost XFF IP and throws when disabled. Edge router blocks SSRF to internal IPs, prevents ReDoS, validates route patterns. CORS throws on wildcard+credentials. Redirect validates URLs. Body parsing stream-limits chunked requests.

  **Reliability**: Structured logging for fire-and-forget hooks. SSE auto-close for stale channels. Cron/rate-limit timers unref'd. Task worker stop has deadline. WebSocket upgrade auth callback.

  **DX**: `TypedRouteOptions` for typed `parsedBody` in `app.route()`. Cache key Vary header support.
