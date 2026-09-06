# Changelog

All notable changes to CelsianJS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note, 2026-08-28.** The same thing happened again: this file stopped at 0.5.5 while
> npm was at 0.6.1, so **0.6.0, the largest security release the project has shipped,
> appeared in no changelog anyone would read**. The two entries below were reconstructed
> from `packages/*/CHANGELOG.md`, which changesets generates and which were correct
> throughout. The gap is structural, not an oversight: changesets writes per-package
> files and nothing writes this one, so it goes stale every release until someone
> notices. `pnpm check:root-changelog` now fails CI when this file's newest entry is
> behind `packages/core/package.json`, so the third time cannot happen quietly.

## [0.6.3] - 2026-09-06

### Fixed

- The full scaffold now exposes Swagger's **Authorize** control, marks PUT/DELETE
  user operations as requiring Bearer JWTs, and documents the required
  `x-csrf-token` header on POST/PUT/DELETE. Its README walks through development
  token retrieval, authorization, and a protected Swagger mutation.
- Core OpenAPI supports explicit security schemes and per-route security,
  description, and parameter metadata. Parameters merge by `(in, name)`: later
  explicit fields override inferred/earlier fields, omitted fields persist,
  explicit schemas replace whole schemas, and path parameters stay required.
  Duplicate explicit entries appear only once in the generated document.

### Upgrade notes

OpenAPI metadata is documentation only. It does not install authentication hooks,
disable JWT or CSRF checks, or change request validation. Keep runtime guards and
security plugins in place. Public routes remain public.

All 20 public packages release together at 0.6.3. The scaffolder requests at least
this patch so generated metadata types cannot resolve against a pre-fix core.
No external runtime dependencies were added.

## [0.6.2] - 2026-09-05

### Fixed

- Streaming JSON responses are no longer buffered by response-schema validation. Validation still applies to JSON serialized by Celsian, but not manually constructed `Response` bodies.
- Prefix-scoped request guards now run before custom 404 handlers. Protected missing routes may now return the guard's rejection instead of 404.
- Cron day-of-month and day-of-week fields follow Unix OR semantics when both are restricted; affected schedules can run more often than before.
- Development servers bind `127.0.0.1` by default. Explicit IPv6 callers must set `HOST=::1`; production binding is unchanged. Listen failures now explain port conflicts and invalid bind addresses.
- `create-celsian` honors documented short/equal template flags and rejects unknown flags or extra positional arguments rather than silently generating the wrong template. Use npm's `--` separator before template flags.
- SSE safely frames CR/CRLF data and promptly releases cancelled or pre-aborted channels. Node streaming respects backpressure and disconnect cancellation, including when request timeouts are configured. The Node adapter reuses the core transport bridge.
- Response caches preserve repeated-query ordering and invalidate long hashed keys across instances without a process-local index.

### Upgrade notes

Clear or rebuild existing persistent response-cache entries during rollout. Old entries may collapse repeated-query ordering or lack the full identity metadata needed to invalidate long hashed keys; the original identity cannot be reconstructed. If clearing is not feasible, isolate the new cache namespace until old entries have expired. Hashed-key invalidation now reads stored metadata and adds KV reads; ordinary short-key hits do not add metadata lookups.

All 20 public packages release together at 0.6.2. No external runtime dependencies were added. The scaffolder now requests at least this patch within the 0.6 release line.

## [0.6.1] - 2026-07-27

### Fixed

- **`@celsian/cli`: the app-probe cold-start budget is 120s, was 30s** (`225834a`).
  `celsian routes` and friends load your entry through `npx tsx` in a child process.
  30s covered that cold start on an idle machine but was observed timing out on a
  loaded CI runner, failing an otherwise green run. The probe exits as soon as it has
  answered, so the larger ceiling costs nothing in the normal case.

## [0.6.0] - 2026-07-27

The security-hardening release. Fourteen separately-reported issues across
`@celsian/core`, `@celsian/cache`, `@celsian/jwt`, `@celsian/rpc` and
`@celsian/adapter-bun`, several of which are remotely exploitable against a default
configuration. **Read the Breaking section before upgrading**: most of these fixes
reject a request that previously succeeded, which is the point of them.

### 🔒 Security

- **Plugin hooks never ran for an un-prefixed `app.register()`** (`408f4af`). Route
  hook chains were snapshotted at `addRoute()` time and read from the root context at
  request time, so `app.register(csrf())` guarded nothing, and `preParsing`,
  `preValidation` and `onError` registered inside a plugin never ran. This is the one
  to check first: an app that looked guarded was not. Hook chains and request/reply
  decorations now resolve lazily from the route's context chain, so registration order
  no longer matters.
- **`request.url` carried the address the server bound to, not the host the client
  addressed** (`1e92ae8`). `serve()` composes `http://${host}:${port}`, and `host` is
  the wildcard `0.0.0.0` under `NODE_ENV=production`. Three separately-reported bugs
  shared this root cause: `trustProxy` and `trustedHosts` were dead code; the CSRF
  origin check was **inverted**, rejecting legitimate same-origin POSTs with 403 while
  passing requests with no `Origin` at all; and the shared response cache keyed every
  tenant to the same `0.0.0.0` authority, serving one tenant's body to another.
- **WebSocket handshakes were accepted with no Origin check and no `onRequest` hook**
  (`1a066de`, then `d668e87`). Handshakes are exempt from the same-origin policy and
  CORS, so any page could open an authenticated socket against a cookie-session app.
  Upgrades now run an Origin allow-list, the app's `onRequest` hooks, a per-IP
  connection cap (64) and a 1 MiB `maxPayload` in place of `ws`'s 100 MB default. The
  first fix read only `app.addHook` hooks, so plugin-registered guards were still
  skipped: an HTTP request got 401 while the handshake got 101. Both are closed.
- **File serving escaped its root, then raced** (`509e696`, then `d668e87`).
  `reply.sendFile()` / `reply.download()` served any path a handler produced, so a
  handler interpolating user input served arbitrary files. They are now confined to
  `options.root`. The first fix returned a resolved path string that was re-opened by
  name, leaving a TOCTOU window: 170 of 2000 concurrent requests returned content from
  outside the root. Files are opened once with `O_NOFOLLOW` and read from that handle.
  `serve({ staticDir })` had been left on a lexical check only, so the same process
  refused a symlink through `sendFile` (403) and served it through `staticDir` (200);
  both paths now share one confinement helper.
- **Open redirect** (`509e696`, then `1e92ae8`). `reply.redirect()` accepted
  protocol-relative targets and absolute URLs to arbitrary hosts. The first fix
  normalized `\` and rejected `//`, but a URL parser also *deletes* ASCII tab, newline
  and carriage return before parsing, so `/<TAB>/evil.com` passed validation and the
  browser resolved it to `https://evil.com/`. Those are now stripped to a fixed point.
- **Two rate-limit key bypasses** (`1e92ae8`). When the forwarded chain was shorter
  than the configured hop count the clamp selected the leftmost, fully client-supplied
  entry: unlimited quota by rotating one header, and the ability to exhaust a
  *different* user's bucket. It now fails closed. Keys were also raw header text, so
  `1.2.3.4`, `01.02.03.04`, `::ffff:1.2.3.4` and `1.2.3.4:<port>` each got their own
  bucket; keys are canonicalized and over-long custom keys hashed.
- **Upload filenames escaped the upload directory** (`509e696`, then `1e92ae8`).
  `sanitizeFileName` stripped leading dots *before* trimming whitespace, so a leading
  space shielded them and the trim re-exposed them: `" .."` came back as `".."`.
  Trimming and dot-stripping now run to a fixed point, and `.`, `..`, empty results,
  Windows reserved device names and trailing dots are rejected.
- **Aliased request paths walked around gateway rules** (`509e696`). `//admin`,
  `/./admin` and `/admin//` reached the same handler as `/admin`, so a request could
  bypass an upstream rule written against the canonical path. They are now 404s.
- **CSRF tokens were not bound to the session** (`509e696`). A token minted before
  login stayed valid after it. Tokens are re-issued when the session id changes, and a
  request announcing itself as cross-site via `Sec-Fetch-Site` or a mismatched
  `Origin` is rejected before the token is checked.
- **SSE fields were not sanitized** (`509e696`). A newline smuggled into `event:` or
  `id:` closed the frame and forged extra events into a victim's stream.
- **Cache poisoning through host-rewrite headers outside the denylist** (`d668e87`).
  `forwarded` (the RFC 7239 standard header), `x-forwarded-scheme`, `x-forwarded-port`,
  `x-forwarded-prefix`, `x-forwarded-uri`, `x-forwarded-ssl`, `x-http-host-override`,
  `x-original-host` and `x-original-uri` are now partitioned eagerly. A denylist cannot
  be complete, and the README now says so: any request header a handler reflects into a
  response must be listed in `varyHeaders`.
- **Prototype-pollution escape hatch in the RPC wire decoder** (`d668e87`). An
  unrecognised `__t` tag returned the raw `JSON.parse` object, skipping the
  `__proto__`/`constructor`/`prototype` scrub entirely, so any payload could opt out of
  it by inventing a tag.
- **RPC content-type check was a substring match** (`d668e87`). `Content-Type:
  text/plain; charset=application/json` is CORS-simple but passed as JSON, defeating
  the preflight property the JSON requirement exists to guarantee.
- **Ambient JWT guard failed open to an arbitrary realm** (`d668e87`). A route outside
  every realm's scope using a no-argument `createJWTGuard()` authenticated against
  whichever realm registered last, so tenant B's token was accepted on a route
  belonging to no tenant.
- **The 405 `Allow` header disclosed routes behind an encapsulated guard** (`1e92ae8`),
  enumerating methods the caller was not authorized to see.
- **`schema.response: MySchema` was ignored entirely** (`509e696`). Only
  `{ 200: MySchema }` did anything, so a route whose schema forbade extra keys happily
  returned `200 {"id":"1","leaked":"secret"}`.
- **ETags used a 32-bit non-cryptographic hash** (`509e696`) that collided easily, and
  an ETag collision serves a 304 for content that changed. Now SHA-256 truncated to
  128 bits.
- **Swagger UI assets are pinned with subresource integrity** (`509e696`), so a
  compromised CDN cannot inject script into the docs page.

### 💥 Breaking

- **Cross-origin and `Origin`-less WebSocket handshakes are rejected with 403.** Set
  `allowedOrigins` for cross-origin browser clients and `allowMissingOrigin: true` for
  non-browser clients.
- **`//admin`, `/./admin` and `/admin//` are 404s.** Plain trailing-slash tolerance is
  preserved and configurable via the router's `ignoreTrailingSlash` (default `true`).
- **Duplicate and conflicting route registrations throw.** Registering the same method
  and path twice used to silently replace the first handler; two sibling routes
  declaring different param names at the same position (`/a/:id` and `/a/:slug`) also
  throw, because only the first name was ever populated.
- **`reply.sendFile()` / `reply.download()` are confined to `options.root`** (default:
  the process CWD). An escape is a 403, a missing file a 404, and a symlink pointing
  outside the root is refused unless `followSymlinks: true`.
- **RPC `input<T>`'s type parameter changed meaning.** It was the *parsed* type; it is
  now the *schema* type, which is what makes inference work. Any call passing an
  explicit type argument, which is what 0.5.x documented and `create-celsian`
  scaffolded, is now a compile error. Migration: delete the explicit type argument.

  ```ts
  // 0.5.x
  procedure.input<{ name: string }>(Type.Object({ name: Type.String() }))
  // 0.6.0
  procedure.input(Type.Object({ name: Type.String() }))
  ```
- **`@celsian/adapter-node`: the default export is now `serve`.** `ThenAdapter`,
  `buildEnd()` and `entryTemplate` are gone. They targeted a `@celsian/build` pipeline
  that does not exist, so `buildEnd()` could only throw.
- **`@celsian/adapter-bun`: `BunFetchHandler` may now return `undefined`** and
  `createBunHandler` takes an optional options argument.
- **The default cache key includes the scheme** (`GET:https//example.com:/data`), so
  `http://x.app/data` and `https://x.app/data` no longer share an entry. This
  invalidates entries written by earlier versions, which is correct for a safety
  boundary. `invalidate()` still accepts the host-less `GET:/data` form.
- **An unbound `createJWTGuard()` on a route outside every realm now throws** on apps
  with more than one realm registered, instead of silently picking one. With exactly
  one realm the fallback is unchanged.
- **Source maps are no longer published.** Every package ships `files: ["dist"]` and
  deliberately does not ship `src`, so the emitted `.js.map` / `.d.ts.map` pointed at
  `../src/index.ts`, a path never in the tarball: a debugger that could not step into
  anything. `@celsian/core`'s tarball drops 34.5% (172.5 kB → 113.0 kB).
- **`@celsian/cli` no longer has `main` or `types`.** They pointed at the shebang'd CLI
  entry, so `await import("@celsian/cli")` *executed the CLI*. It is consumed through
  its `celsian` binary; importing it now fails cleanly instead of running a program.

### Added

- **The durable task queue is actually durable** (`a1ef683`). A dead-letter queue with
  the final error and full attempt history (`deadLetter`, `listDeadLetters`,
  `redriveDeadLetter`, `redriveDeadLetters`, `purgeDeadLetters`, `deadLetterSize`, plus
  `onFailure` / `onDeadLetter` worker hooks); atomic delayed-message promotion on Redis
  via a Lua script, replacing a `pipeline()` that batches but is not atomic, so every
  concurrent worker duplicated each delayed retry; per-delivery lease tokens so a slow
  worker cannot ack a job another worker has taken over; `ctx.heartbeat()`; an
  at-least-once `MemoryQueue` that reclaims expired leases instead of losing them; task
  timeouts that cancel through `ctx.signal`; a shutdown report naming how many jobs were
  abandoned; and a `CronScheduler.start()` warning on Cloudflare Workers, Lambda,
  Vercel, Netlify, Deno Deploy and Cloud Run, where an in-process timer never fires.
- **`@celsian/adapter-bun` WebSocket support works.** `createBunServeOptions()` never
  set the `websocket` key, so `server.upgrade()` could not succeed and the documented
  support was inoperative.
- **New `strictParams` router option.** A route param that percent-decodes to a value
  containing `/`, `\` or NUL is a 400. Off by default, because runtimes differ in
  whether they pre-decode the path.
- **`serve()` installs `unhandledRejection` / `uncaughtException` handlers** that log
  with full context, drain in-flight requests and exit non-zero (opt out with
  `handleFatalErrors: false`), and detaches its process listeners on close.

### Fixed

- **Cookie `Secure` derives from the request protocol** (`509e696`). It was hardcoded
  `true`, so on plain-HTTP development the browser accepted the `Set-Cookie` and never
  sent the cookie back: login wrote a session that never returned and `clearCookie()`
  logout silently did nothing, both behind a 200. It is now `true` over HTTPS, `false`
  over plain HTTP to a non-routable host (loopback, RFC 1918, link-local, `.local`),
  and still `true` over plain HTTP to a routable host. `NODE_ENV` is not consulted,
  since a missing env var is what caused the original defect.
- **`createVercelCronHandler` runs cron jobs** (`509e696`). It validated `CRON_SECRET`
  and then called `app.handle(request)`, so no `app.cron()` job ever ran and a
  correctly-configured Vercel cron got a 404: scheduled work silently never executed.
- **Real JSON Schema for Zod and Valibot in OpenAPI** (`0042f48`). Generation was
  materially broken for the two libraries nearly every example uses.
- **Valibot schemas infer** (`509e696`). Valibot 1.x carries its output type on
  `~types`, which `InferOutput` did not check, so every Valibot-typed route inferred
  `unknown` and reading `request.parsedBody` raised TS18046 despite runtime validation
  working.
- **Typed RPC clients resolve to the procedure map instead of `never`** (`509e696`).
  Under `strictFunctionTypes` every procedure fell to the `never` branch, so a typed
  client had no callable members at all.
- **`createRPCClient<any>()` is usable again** (`e75e588`); **the Zod adapter accepts
  real Zod 4 schemas again** (`e75e588`, `ZodIssue.path` is `PropertyKey[]` in Zod 4);
  **`CelsianRequest.cookies` is declared** rather than reachable only through the
  plugin index signature, so `req.cookies.session` no longer arrives as `unknown`.
- **`app.route({ url })` infers params**, `405` responses carry an `Allow` header,
  `inject()` accepts `cookies` (documented but silently dropped), `trackedPool()`
  accepts pools that close with `end()` such as `pg.Pool`, and `413` responses name the
  byte limit and the config key that raises it.
- **WebSocket handlers see the client's host, not the bind address** (`7e85b5a`). Any
  handler dispatching on host, which is how a multi-tenant app routes, saw
  `http://0.0.0.0:3000/chat` for every tenant.
- **`celsian` and `create-celsian` declare `publishConfig.access: "public"`**, the only
  two publishable packages missing it, and `@celsian/adapter-bun` / `@celsian/adapter-deno`
  widen their `@celsian/core` peer range to `>=0.5.0 <1.0.0` from an exact pin.

> **Note, 2026-07-26.** This root changelog had stopped at 0.5.2 while npm was at 0.5.5,
> so 0.5.3, 0.5.4 and 0.5.5 were never written up here. Most seriously, 0.5.5 contains a
> **security fix for cross-user response disclosure** that appeared in no changelog anyone
> would read. The three entries below were reconstructed from git history and the
> per-package changelogs. Per-package changelogs under `packages/*/CHANGELOG.md` are
> generated by changesets and were correct throughout; only this aggregate file was stale.

## [0.5.5] - 2026-07-24

### 🔒 Security

- **Cross-user response disclosure via the shared response cache (`@celsian/cache`).**
  A shared response cache could return one user's response to another. Fixed by:
  bypassing the cache entirely for credentialed requests; partitioning reflected-CORS
  responses by `Origin`; refusing to store `no-cache`, zero-age and `private` responses;
  and storing a `Vary` response only when every request field it varies on is actually
  represented in the cache key.
  **If you use `@celsian/cache`'s response cache on authenticated routes, upgrade.**
- **JWT realm bleed (`@celsian/jwt`).** Removed the module-global JWT guard fallback. A
  no-argument `createJWTGuard()` previously could resolve a secret or algorithm from a
  module-level global rather than from the app handling the request, so in a process
  running more than one app, one app's JWT configuration could validate another's tokens.
  Guards now resolve secrets and algorithms only from the current app's request.

Commits: `d574a13` (fix), `d50e11b` (release).

## [0.5.4] - 2026-07-18

### Fixed
- **@celsian/schema, @celsian/adapter-node:** fail loud on silent validation and build
  no-ops rather than quietly succeeding (`74898eb`).

### Changed
- **tests:** schema adapters are now covered against the real `zod`, `@sinclair/typebox`
  and `valibot` packages instead of hand-written fakes, so an upstream breaking change
  surfaces here instead of passing against a stub (`c9bf004`).

## [0.5.3] - 2026-07-12

### Fixed
- **@celsian/core (fail-loud config):** `loadConfig()` no longer swallows a broken
  `celsian.config.*` with a bare `catch`. A genuinely absent config still falls back to
  defaults, but a config that exists and fails to load (syntax error, runtime error, or a
  missing import) now throws the new exported `ConfigLoadError` naming the file and cause.
  `serve()` surfaces it instead of silently binding defaults.
- **@celsian/cli (`celsian dev`):** checks the entry file exists before spawning `tsx`,
  printing `Entry file not found: <entry>` plus usage instead of a raw "Cannot find
  module" stack trace.
- **@celsian/cli (`celsian generate rpc`):** scaffolds a mountable, type-correct starting
  point (wrapped in `router()`, exported as a registerable `PluginFunction` that calls
  `new RPCHandler(...).mount(app)`) instead of a bare object with no path to a live
  endpoint and an always-`undefined` destructured `input`.

### Changed
- **@celsian/jwt:** `jose` 5.10.0 to 6.2.2 (major upstream bump, no API change here).
- **@celsian/ws-redis, @celsian/queue-redis:** `ioredis` 5.9.3 to 5.11.1.

Commit: `a60b3e4`.

## [0.5.2] - 2026-06-10

Hardening release driven by the 2026-06-09 triple audit. Fixes 2 critical
deployment bugs, a rate-limiter bypass, serverless-adapter fidelity, and every
documented example that previously crashed. `pnpm test`: 1539 passing.

### ⚠️ Behavior changes (read before upgrading)

- **Default server host is now `0.0.0.0` in production.** Previously `serve()`
  always bound `localhost`, which resolves to IPv6 loopback (`::1`) and made the
  server unreachable from a Docker/Fly/Railway port mapping. It now binds
  `0.0.0.0` when `NODE_ENV=production` (and `localhost` in development), honoring
  an explicit `host` option or `HOST` env var first. If you relied on loopback-only
  binding as a firewall in production, set `host: '127.0.0.1'` (or `HOST`) explicitly.
- **Rate limiter now keys on the rightmost-untrusted `X-Forwarded-For` hop.**
  With `trustProxy: true`, the client IP is taken `trustedProxyHops` (default 1)
  from the right, not the leftmost value (which is attacker-controlled and allowed
  a full bypass). **Set `trustedProxyHops` to your actual proxy depth** if you run
  behind more than one proxy, or clients may be keyed by a proxy IP.
- **`rateLimit()` now throws at registration** on a missing/`NaN`/non-positive
  `window` or `max` (previously these silently disabled limiting). Apps that were
  accidentally passing `windowMs` instead of `window` will now fail fast.
- **RPC 5xx errors are sanitized in production.** Raw `error.message` is no longer
  returned to clients when `NODE_ENV=production` (full detail is still logged
  server-side). `HttpError`s below 500 still pass through.

### Added
- **adapter-lambda:** API Gateway v1 (REST) and ALB event support (was v2-only).
- **adapter-cloudflare:** `scheduled` handler bridging CF Cron Triggers to `app.cron` jobs.
- **rpc:** `RPCHandler.mount(app, prefix?)` convenience registration (replaces the
  documented-but-nonexistent `app.all(...)` pattern).
- **core:** options-object route signature `app.post(url, { schema, handler })`;
  explicit `requestTimeout`/`headersTimeout` serve options; `docs/errors.md` error reference.
- **CI:** real npm provenance, concurrency cancellation, a blocking Deno job, an advisory
  (non-blocking) Bun job, a workerd smoke job, and `size-limit` budgets.
  <br>*Corrected 2026-07-26: this originally read "blocking Bun/Deno jobs". The Bun job
  has `continue-on-error: true` and is force-killed on hang, and `ci-passed` explicitly
  does not gate on it. Only the Deno job blocks.*

### Fixed
- **CRITICAL, core:** `serve()` loopback-only bind (see behavior changes); now logs the bound address.
- **CRITICAL, cli:** `celsian routes` crashed in every project (tsx `--eval` top-level-await under CJS); rewritten to a temp `.mts` loader that surfaces real errors.
- **adapter-lambda:** request cookies dropped (`event.cookies` now read) and binary request bodies corrupted (base64 kept as bytes, no UTF-8 round-trip).
- **adapter-vercel:** `createVercelEdgeHandler` could not bundle for edge (module-level `node:crypto`); timing-safe compare moved to Web Crypto.
- **core:** CSRF `excludePaths` now match by path segment (`/_rpc` excludes `/_rpc/x` but not `/_rpcx`); CORS sets `Vary: Origin` on reflected origins; custom content-type parsers respect `bodyLimit`; cron no longer double-fires within a minute; binary `reply.send()` emits `application/octet-stream`; serverless-safety warnings surface through the default logger; `serve()` resolves only after listening and reports the OS-assigned port.
- **rate-limit:** `MemoryRateLimitStore` caps key cardinality (`maxKeys`, default 100k) with DoS-safe eviction.
- **jwt:** warns on HS* secrets shorter than 32 bytes.
- **create-celsian:** rest-api template email validation worked (was `Unknown format 'email'`); full template's CSRF no longer 403s RPC mutations; `.env` is actually loaded; refuses to overwrite a non-empty directory without `--force`; templates ship `.gitignore`/`README`; project names are validated; prod JWT guard rejects the shipped placeholder secret.
- **docs:** every previously-crashing sample fixed (ESM `"type": "module"` requirement, rate-limit `trustProxy`, the 5 Fastify-migration API errors); `SECURITY.md` uses GitHub private reporting; internal planning docs relocated to `docs/internal/`.

## [0.5.1] - 2026-06-08

Performance and benchmark-honesty release. No behavior changes.

### Performance
- **core:** faster Node request/response path (~+11–38% req/s across scenarios; JSON 41.4K → 51.9K req/s, ~74% of Fastify).
  - Buffered responses from `reply.json()/send()/html()` and the auto-serializer write in a single `res.writeHead()` + `res.end()` with an explicit `Content-Length`, instead of draining a `ReadableStream` reader.
  - `buildRequestFast()` builds the per-request wrapper from a shared prototype, eliminating 6 `.bind()` and 2 `Object.defineProperty` calls per request (~10× cheaper to construct).
  - `nodeToWebRequestFast()` passes Node's header record straight to `Request` in the common all-string case.

### Changed
- **benchmarks:** honest, isolated memory benchmark (`benchmarks/mem.ts`) replaces the previous shared-process RSS-delta measurement, which was order-biased and overstated memory for whichever framework ran first. Retained heap is on par with Express and below Fastify. Added `benchmarks/soak.ts` for sustained-load leak checks. Multi-runtime serving verified on Node, Bun, Deno, Cloudflare Workers, and AWS Lambda.
- **site:** updated marketing site for 0.5.1, current performance numbers, version, all 8 adapters, fixed `/docs` link.

## [0.5.0] - 2026-06-07

Production-hardening release. **All public packages are now unified on a single version line**
(changesets `fixed` group) so versions can no longer drift; the mistaken `@celsian/adapter-bun`
and `@celsian/adapter-deno` `1.0.0` publishes are superseded by `0.5.0` (and should be deprecated).

### Security
- **core:** prototype-pollution scrub on parsed JSON bodies; `trustProxy` honors `x-forwarded-host`
  only for a configured `trustedHosts` allowlist (host-header injection); CSRF cookie `Secure` in
  production; cookie name/domain/path sanitized; `sendFile` traversal check fixed for sibling-prefixed
  roots; malformed percent-encoding (`/%ZZ`) returns 400 instead of crashing.
- **cache:** response cache no longer replays per-user `Set-Cookie`/`Authorization` across users
  (credential-header denylist; security/representation headers preserved).
- **rate-limit:** fails closed for unidentifiable clients (was bypassable to unlimited throughput).
- **jwt:** lazy `createJWTGuard()` resolves each app's secret/algorithms from the request, fixes
  cross-app secret bleed and honors configured algorithms.

### Fixed
- **core:** invalid cron fields (`*/0`, NaN, out-of-range) throw instead of hanging the event loop;
  request timeout now aborts the handler via `request.signal`; malformed/oversized bodies return
  400/413; errors route through the structured logger.
- **queue-redis:** atomic pop (Lua) with an in-flight reaper honoring `visibilityTimeout`; ioredis
  `error` listeners prevent process crashes during a Redis outage. (Key schema `:inflight` →
  `:processing`/`:stamps`, drain in-flight messages before upgrading.)
- **ws-redis:** real cross-node `broadcastAll('*')` fan-out; ioredis `error` listeners.
- **schema:** StandardSchema-first detection (modern Zod/Valibot); TypeBox via its Kind symbol.
- **create-celsian:** templates pin a valid unified range and `export const app` so `celsian routes`
  works; `generate rpc` uses `src/routes/`; scaffolds `vitest@^4`.

### Changed
- `MemoryKVStore` now defaults to a bounded LRU (`maxEntries: 0` restores unbounded).
- Added `@celsian/core` `./package.json` export; added a Deno CI job.

## [0.4.0]

Production-hardening release. Highlights: security fixes (rate-limit IP spoofing, JWT secret scoping, session regeneration, Lambda proto validation, error stack guards), `app.ts` decomposed into `body-parser` and `error-handler` modules, file upload plugin, Bun and Deno adapters, `@celsian/ws-redis` distributed WebSocket, a `deploy` command with platform auto-detection, integration/stress tests, and the Fastify migration guide.

See the [GitHub release](https://github.com/CelsianJs/celsian/releases) for full notes.

## [0.3.x]

Iterative patch series between 0.2.0 and 0.5.0. Notable changes: security headers applied to framework-generated 404/405 responses; rate limiter uses the rightmost `X-Forwarded-For` IP and throws when misconfigured; edge router SSRF/ReDoS hardening; structured logging for fire-and-forget hooks; `TypedRouteOptions` for a typed `parsedBody` in `app.route()`.

See the [GitHub releases](https://github.com/CelsianJs/celsian/releases) for the full 0.3.x history.

## [0.2.0] - 2026-03-26

### Added

- **RPC module** (`@celsian/rpc`): Type-safe remote procedure calls with a typed client and OpenAPI output
  <br>*Corrected 2026-07-26: this originally read "client generation". There is no codegen
  step. `createRPCClient<AppRouter>()` is a runtime `Proxy` (`packages/rpc/src/client.ts`)
  that gets its types purely from the `AppRouter` type parameter. Nothing is generated or
  written to disk.*
- **Schema package** (`@celsian/schema`): Universal validation adapters for Zod, TypeBox, and Valibot via StandardSchema
- **Task system** (`@celsian/core`): Background task queue with retry, timeout, and pluggable backends
- **Cron scheduler** (`@celsian/core`): 5-field unix cron with no external dependencies
- **WebSocket support** (`@celsian/core`): First-class WebSocket routing and connection management
- **SSE support** (`@celsian/core`): Server-Sent Events with hub/channel pattern
- **JWT plugin** (`@celsian/jwt`): JSON Web Token authentication via `jose`
- **Cache plugin** (`@celsian/cache`): Response caching, session store, and pluggable cache backends
- **Compression plugin** (`@celsian/compress`): Gzip/Deflate response compression
- **Rate limiting** (`@celsian/rate-limit`): Fixed-window rate limiter with pluggable store
- **CSRF plugin** (`@celsian/core`): Double-submit cookie CSRF protection
- **ETag plugin** (`@celsian/core`): Automatic ETag generation and `304 Not Modified` responses
- **Security headers plugin** (`@celsian/core`): Configurable HTTP security headers (CSP, HSTS, etc.)
- **Database plugin** (`@celsian/core`): Connection pool management with transaction lifecycle hooks
- **Analytics plugin** (`@celsian/core`): Query timing, slow query logging, and DB metrics
- **OpenAPI plugin** (`@celsian/core`): Auto-generate OpenAPI 3.1 specs from route definitions
- **Content negotiation** (`@celsian/core`): `accepts()`, `acceptsEncoding()`, `acceptsLanguage()` helpers
- **Cookie parsing** (`@celsian/core`): Zero-dep cookie parse/serialize
- **CLI tooling** (`@celsian/cli`): `dev`, `build`, `create`, `generate`, and `routes` commands
- **Adapter: Cloudflare Workers** (`@celsian/adapter-cloudflare`)
- **Adapter: AWS Lambda** (`@celsian/adapter-lambda`)
- **Adapter: Vercel** (`@celsian/adapter-vercel`)
- **Adapter: Fly.io** (`@celsian/adapter-fly`)
- **Adapter: Railway** (`@celsian/adapter-railway`)
- **Edge router** (`@celsian/edge-router`): Cloudflare Workers-based edge routing and proxying
- **Redis queue** (`@celsian/queue-redis`): Redis-backed task queue via ioredis
- **Structured errors**: `CelsianError`, `HttpError`, `ValidationError` with dev-mode stack traces
- **Structured logger**: Pino-style JSON logger with child loggers and request IDs
- **Hook system**: `onRequest`, `preHandler`, `onSend`, `onResponse`, `onError` lifecycle hooks
- **Inject testing**: In-process request injection for fast, serverless testing
- **Body limit enforcement** with configurable per-route limits
- **Path traversal protection** for static file serving
- **Route manifest** generation for introspection

### Changed

- Renamed from internal prototype to CelsianJS public release
- Migrated to pnpm workspaces monorepo structure
- All packages use ESM-only (`"type": "module"`)

## [0.1.0] - 2026-02-15

### Added

- Initial internal prototype with core router, middleware hooks, and Node.js adapter
