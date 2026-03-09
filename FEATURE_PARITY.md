# CelsianJS Feature Parity Report

**Compared against: Express 4.x, Fastify 4.x**
**CelsianJS audit date: 2026-03-08**

---

## 1. Feature Comparison Tables

### Express Feature Parity

| Feature | Status | Notes |
|---------|--------|-------|
| **Routing** | | |
| Route params (`:id`) | ✅ Full support | Radix tree router with `:param` segments |
| Query parsing | ✅ Full support | Auto-parsed from URL into `req.query`, supports multi-value |
| Wildcard routes (`*`) | ✅ Full support | `*name` captures rest of path |
| Regex routes | ❌ Not supported | Router only supports string patterns with `:param` and `*wildcard` |
| Route method shorthand (get/post/put/patch/delete) | ✅ Full support | `app.get()`, `app.post()`, etc. |
| HEAD fallback to GET | ✅ Full support | Automatic fallback in `app.handle()` |
| OPTIONS handling | ✅ Full support | Via CORS plugin's catch-all `OPTIONS /*path` route |
| 405 Method Not Allowed | ✅ Full support | `router.hasPath()` differentiates 404 vs 405 |
| **Middleware** | | |
| `app.use()` global middleware | ⚠️ Partial | No `app.use()` — equivalent via `app.addHook('onRequest', ...)` |
| Router-scoped middleware | ✅ Full support | Plugin encapsulation scopes hooks to child contexts |
| Error-handling middleware | ✅ Full support | `app.addHook('onError', handler)` with `(error, req, reply)` signature |
| Route-specific middleware | ✅ Full support | `onRequest`, `preHandler` hooks per route via `RouteOptions` |
| Middleware chaining (next()) | ⚠️ Partial | Hooks run sequentially; early return via `Response` instead of `next()` |
| **Request helpers** | | |
| `req.params` | ✅ Full support | `request.params` record |
| `req.query` | ✅ Full support | `request.query` record with multi-value support |
| `req.body` | ✅ Full support | Auto-parsed as `request.parsedBody` (JSON, form, text) |
| `req.headers` | ✅ Full support | Standard Web API `Headers` object |
| `req.ip` | ⚠️ Partial | No `req.ip` property; available via `req.headers.get('x-forwarded-for')` |
| `req.hostname` | ⚠️ Partial | No dedicated property; available via `new URL(req.url).hostname` |
| `req.path` | ⚠️ Partial | No dedicated property; available via `new URL(req.url).pathname` |
| `req.cookies` | ✅ Full support | Lazy-parsed `request.cookies` record |
| `req.method` | ✅ Full support | Standard `request.method` |
| `req.url` | ✅ Full support | Standard `request.url` |
| **Response helpers** | | |
| `res.json()` | ✅ Full support | `reply.json(data)` |
| `res.send()` | ✅ Full support | `reply.send(data)` — auto-detects string vs object |
| `res.redirect()` | ✅ Full support | `reply.redirect(url, code)` |
| `res.status()` | ✅ Full support | `reply.status(code)` — chainable |
| `res.set()` / `res.header()` | ✅ Full support | `reply.header(key, value)` — chainable |
| `res.cookie()` | ✅ Full support | `reply.cookie(name, value, options)` with full cookie options |
| `res.clearCookie()` | ✅ Full support | `reply.clearCookie(name, options)` |
| `res.type()` | ⚠️ Partial | No shorthand; use `reply.header('content-type', '...')` |
| `res.download()` | ❌ Not supported | No file download helper |
| `res.sendFile()` | ❌ Not supported | No file-sending helper |
| `res.html()` | ✅ Full support | `reply.html(content)` — not in Express but a nice addition |
| `res.stream()` | ✅ Full support | `reply.stream(readable)` — not in Express |
| Status code helpers | ✅ Full support | `reply.notFound()`, `reply.badRequest()`, `reply.unauthorized()`, etc. |
| **Static file serving** | ⚠️ Partial | Built into `serve()` via `staticDir` option; no `express.static()`-style middleware, no range requests, no directory listing |
| **Template engines** | ❌ Not supported | No `res.render()` or template engine integration |
| **Trust proxy / X-Forwarded-For** | ✅ Full support | `trustProxy: true` option rewrites proto/host from forwarded headers |
| **Sub-apps / mounting** | ✅ Full support | `app.register(plugin, { prefix: '/api' })` with full encapsulation |
| **Error handling** | ✅ Full support | `onError` hooks, `HttpError`, `ValidationError`, production error sanitization |

### Fastify Feature Parity

| Feature | Status | Notes |
|---------|--------|-------|
| **Schema validation** | | |
| JSON Schema / TypeBox | ✅ Full support | `@celsian/schema` adapts TypeBox natively |
| Zod | ✅ Full support | Auto-detected via duck-typing |
| Valibot | ✅ Full support | Auto-detected via `_parse` method |
| Body schema | ✅ Full support | `schema.body` in route options |
| Querystring schema | ✅ Full support | `schema.querystring` in route options |
| Params schema | ✅ Full support | `schema.params` in route options |
| Response schema | ⚠️ Partial | `schema.response` defined but only used for OpenAPI generation, not for output serialization/validation at runtime |
| **Serialization** | ⚠️ Partial | No `fast-json-stringify` equivalent; uses standard `JSON.stringify` |
| **Hooks lifecycle** | | |
| onRequest | ✅ Full support | Both app-level and route-level |
| preParsing | ✅ Full support | Runs before body parsing |
| preValidation | ✅ Full support | Runs before schema validation |
| preHandler | ✅ Full support | Both app-level and route-level |
| preSerialization | ✅ Full support | Both app-level and route-level |
| onSend | ✅ Full support | Both app-level and route-level |
| onResponse | ✅ Full support | Fire-and-forget after response sent |
| onError | ✅ Full support | Error handler hooks |
| onTimeout | ⚠️ Partial | Request timeout exists (`requestTimeout` option) but no dedicated `onTimeout` hook |
| **Decorators** | | |
| `decorateRequest` | ✅ Full support | `app.decorateRequest(name, value)` |
| `decorateReply` | ❌ Not supported | No `decorateReply()` — headers/helpers on reply are fixed |
| `decorate` (app) | ✅ Full support | `app.decorate(name, value)` with conflict detection |
| **Plugins & encapsulation** | ✅ Full support | Full encapsulation with child contexts, `encapsulate: false` option for cross-cutting |
| **Logging** | ✅ Full support | Pino-style structured JSON logger, child loggers with bindings, per-request `req.log` |
| **Content type parser** | ⚠️ Partial | Built-in JSON, form-data, text parsing; no custom content-type parser API |
| **Reply helpers** | | |
| `reply.code()` / `reply.status()` | ✅ Full support | `reply.status(code)` |
| `reply.header()` | ✅ Full support | `reply.header(key, value)` |
| `reply.type()` | ⚠️ Partial | No shorthand; use `reply.header('content-type', '...')` |
| `reply.redirect()` | ✅ Full support | `reply.redirect(url, code)` |
| `reply.serialize()` | ❌ Not supported | No custom serialization |
| **Not found handler** | ⚠️ Partial | Returns structured JSON 404 automatically; no custom `setNotFoundHandler()` |
| **Error handler** | ✅ Full support | `onError` hooks, custom error handler per plugin scope |
| **Graceful shutdown** | ✅ Full support | SIGTERM/SIGINT handling, in-flight request drain, configurable timeout, `onShutdown` hook |
| **Testing (inject)** | ✅ Full support | `app.inject({ method, url, payload, headers, query })` — no real server needed |
| **TypeScript support** | ✅ Full support | Written entirely in TypeScript with full type exports |
| **Rate limiting** | ✅ Full support | `@celsian/rate-limit` — sliding window, pluggable store, custom key generator |
| **CORS** | ✅ Full support | Built-in `cors()` plugin with origin allow-list, credentials, preflight |
| **JWT auth** | ✅ Full support | `@celsian/jwt` — sign/verify via `jose`, route guard helper |
| **Multipart/form-data** | ✅ Full support | Parsed automatically via `request.formData()` (Web API) |
| **Cookie support** | ✅ Full support | Parse, serialize, set, clear — all with full options (httpOnly, secure, sameSite, etc.) |
| **WebSocket** | ✅ Full support | Built-in registry, broadcast, rooms; Node (ws), Bun, Deno adapters |
| **Static files** | ⚠️ Partial | Served via `staticDir` in `serve()` and adapters; no `@fastify/static`-equivalent plugin with etag, range, etc. |
| **Auto-documentation (Swagger/OpenAPI)** | ✅ Full support | Built-in `openapi()` plugin — OpenAPI 3.1 spec + Swagger UI, auto-detects path/query params and schemas |

### Production Features

| Feature | Status | Notes |
|---------|--------|-------|
| **Graceful shutdown** | ✅ Full support | SIGTERM/SIGINT, in-flight drain, configurable timeout, cleanup hooks, worker/cron shutdown |
| **Health checks** | ✅ Full support | `app.health()` — `/health` and `/ready` endpoints with custom check functions |
| **Metrics/monitoring** | ⚠️ Partial | DB query metrics and Server-Timing header via `dbAnalytics()`; no Prometheus/StatsD export |
| **Configuration management** | ✅ Full support | `celsian.config.ts/js/mjs` with `defineConfig()`, env-aware loading |
| **Environment-specific settings** | ⚠️ Partial | `NODE_ENV` / `CELSIAN_ENV` checked for production error sanitization; no multi-env config profiles |
| **Clustering/workers** | ❌ Not supported | No built-in cluster mode or worker threads |
| **HTTPS/TLS** | ❌ Not supported | No TLS config in `serve()`; relies on reverse proxy |
| **HTTP/2** | ❌ Not supported | No HTTP/2 support; relies on reverse proxy |
| **Compression** | ✅ Full support | `@celsian/compress` — gzip/deflate via `CompressionStream`, configurable threshold |
| **Rate limiting** | ✅ Full support | `@celsian/rate-limit` with memory and pluggable stores |
| **Caching** | ✅ Full support | `@celsian/cache` — response caching with KV store, ETag helper, cache invalidation |
| **Session management** | ✅ Full support | `@celsian/cache` — session create/load/destroy/regenerate with KV store |
| **CSRF protection** | ❌ Not supported | No built-in CSRF token generation or validation |
| **Security headers** | ✅ Full support | `security()` plugin — Helmet-style (HSTS, X-Frame-Options, CSP, etc.) |
| **Content negotiation** | ✅ Full support | `accepts()`, `acceptsEncoding()`, `acceptsLanguage()` utilities |
| **Request timeout** | ✅ Full support | Configurable `requestTimeout` (default 30s), returns 504 on timeout |
| **Body size limit** | ✅ Full support | Configurable `bodyLimit` (default 1MB), returns 413 on exceed |
| **Request ID** | ✅ Full support | Auto-generated per request, attached to `req.requestId` and logger |

### Bonus: Features CelsianJS Has That Express/Fastify Do Not (Out of the Box)

| Feature | Notes |
|---------|-------|
| **Background task system** | `app.task()` / `app.enqueue()` with retries, timeouts, concurrency control |
| **Queue backends** | Memory queue built-in, `@celsian/queue-redis` for production |
| **Cron scheduling** | `app.cron(name, schedule, handler)` — zero-dependency 5-field unix cron |
| **Type-safe RPC** | `@celsian/rpc` — tRPC-style procedures with middleware, OpenAPI generation, client codegen |
| **SSE (Server-Sent Events)** | First-class `createSSEStream()` and `createSSEHub()` with auto-ping and broadcast |
| **DB analytics** | `trackedPool()` wrapper with per-request query metrics and slow query logging |
| **Transaction lifecycle** | `withTransaction()` hook + `transactionLifecycle()` plugin for auto-commit/rollback |
| **Route manifest** | `app.getRouteManifest()` for deployment tooling (serverless/hot/task routing) |
| **Multi-runtime** | Bun, Deno, Node.js, Cloudflare Workers, AWS Lambda, Vercel, Fly.io, Railway adapters |
| **Web Standard Request/Response** | Built on Web APIs — portable across all JS runtimes |

---

## 2. Critical Gaps (Adoption Blockers)

These are features that teams migrating from Express or Fastify would expect and whose absence could block adoption:

1. **No `res.sendFile()` / `res.download()`** — Any API that serves user-uploaded files, PDFs, or binary downloads needs this. Workaround exists (manually read file, create Response with correct headers), but it is boilerplate-heavy and error-prone (range requests, MIME detection, etc.).

2. **No custom content-type parser API** — Fastify allows registering custom parsers for any content type (e.g., `text/xml`, `application/msgpack`). CelsianJS hardcodes JSON/form/text parsing. APIs consuming non-standard content types must handle parsing manually in handlers.

3. **No `setNotFoundHandler()` / custom 404** — The 404 response is a fixed JSON object. Many apps need custom 404 pages (HTML) or middleware that runs on 404 (e.g., SPA fallback to index.html). This is a common pattern that currently requires a wildcard catch-all route.

4. **No HTTPS/TLS support** — While most production deployments use a reverse proxy (nginx, Caddy), many developers expect `createServer` to accept a TLS cert for local HTTPS development and simple deployments.

5. **No `decorateReply()`** — Fastify's `decorateReply()` is used heavily for attaching request-scoped helpers (e.g., `reply.sendCSV()` in plugins). Currently no way to extend the reply object per-plugin.

6. **No regex routes** — Some Express apps use regex patterns for complex route matching (e.g., `/\/api\/v[12]\/users/`). These would need refactoring.

---

## 3. Nice-to-Have Gaps (Noticeable but Workable)

These are features that experienced developers will notice are missing, but can work around:

1. **No `app.use()` syntax** — Developers coming from Express expect `app.use(middleware)`. The hook-based approach (`addHook`) achieves the same thing but requires learning a different API.

2. **No `res.type()` shorthand** — Minor convenience; `reply.header('content-type', 'text/csv')` works fine.

3. **No `req.ip`, `req.hostname`, `req.path` convenience properties** — All data is accessible via headers or URL parsing, but dedicated properties reduce boilerplate.

4. **No template engine integration** — No `res.render()`. Modern APIs are typically JSON-only, but full-stack apps or admin panels may need server-side rendering. HTML can still be returned via `reply.html()`.

5. **No response schema validation at runtime** — The `schema.response` field is defined but only used for OpenAPI doc generation. Fastify validates and serializes responses against the schema, which catches bugs and improves serialization performance.

6. **No Brotli compression** — `@celsian/compress` supports gzip and deflate. Brotli requires the `CompressionStream` API to support it (Node 21+), or a polyfill.

7. **No Prometheus / StatsD metrics export** — DB metrics exist but there is no standard metrics endpoint for production monitoring dashboards.

8. **No multi-environment config profiles** — No built-in `celsian.config.production.ts` vs `celsian.config.development.ts` pattern.

9. **No cluster/worker mode** — For CPU-bound workloads on Node.js, developers must implement clustering themselves or use PM2.

10. **No CSRF protection** — Must be implemented manually or via a third-party library.

---

## 4. CelsianJS Advantages Over Express/Fastify

1. **Multi-runtime portability** — Built on Web Standard APIs (Request/Response). The same app runs on Node.js, Bun, Deno, Cloudflare Workers, AWS Lambda, and Vercel with zero code changes. Neither Express nor Fastify offers this.

2. **Built-in background task system** — `app.task()` + `app.enqueue()` with retries, exponential backoff, configurable concurrency, and swappable queue backends (memory, Redis). Express and Fastify have no equivalent — teams typically add BullMQ or similar separately.

3. **Built-in cron scheduling** — Zero-dependency cron with `app.cron()`. No need for `node-cron` or external schedulers for simple periodic jobs.

4. **Type-safe RPC layer** — `@celsian/rpc` provides tRPC-style type-safe procedures with auto-generated OpenAPI docs and a typed client. This is a significant value-add that Fastify does not ship.

5. **First-class SSE support** — `createSSEStream()` and `createSSEHub()` with auto-ping, client disconnect detection, and broadcast. Express/Fastify require manual stream management.

6. **Hook lifecycle completeness** — CelsianJS matches Fastify's full hook lifecycle (8 hooks) while also providing route-level hooks and fire-and-forget `onResponse`. Express has no lifecycle concept.

7. **Schema-agnostic validation** — Auto-detects Zod, TypeBox, or Valibot via duck-typing. Fastify is tightly coupled to JSON Schema/Ajv. Express has no built-in validation.

8. **Plugin encapsulation model** — Fastify-inspired but with a cleaner API. Plugins get isolated hook/decoration scopes by default, with `encapsulate: false` opt-out.

9. **DB-aware analytics** — `trackedPool()` + `dbAnalytics()` gives per-request query timing, slow query logging, and `Server-Timing` headers with zero config. Neither Express nor Fastify has anything like this built-in.

10. **Test injection without server** — `app.inject()` works without starting a real HTTP server, similar to Fastify but unlike Express (which requires `supertest` or similar).

11. **Structured error handling** — `HttpError`, `ValidationError`, and `CelsianError` classes with production-safe serialization (stack traces stripped in production). Better DX than Express's string-based errors.

12. **Route manifest for deployment** — `app.getRouteManifest()` classifies routes as serverless/hot/task for deployment tooling. Unique to CelsianJS.

---

## 5. Recommended Priority for Closing Gaps

### P0 — Address Before v1.0 (Adoption Blockers)

| Gap | Effort | Impact |
|-----|--------|--------|
| `reply.sendFile()` / `reply.download()` | Medium | High — blocks any file-serving use case |
| Custom 404/not-found handler | Low | High — needed for SPAs and custom error pages |
| Custom content-type parser API | Medium | High — blocks XML, protobuf, msgpack APIs |
| `decorateReply()` | Low | Medium — needed for plugin ecosystem growth |

### P1 — Address Soon After v1.0 (Developer Experience)

| Gap | Effort | Impact |
|-----|--------|--------|
| `req.ip`, `req.hostname`, `req.path` convenience properties | Low | Medium — reduces boilerplate |
| `app.use()` compat layer or alias | Low | Medium — eases Express migration |
| Response schema validation at runtime | Medium | Medium — catches bugs, improves perf |
| Brotli compression | Low | Low-Medium — modern best practice |
| `reply.type()` shorthand | Low | Low — minor convenience |

### P2 — Nice-to-Have (Maturity)

| Gap | Effort | Impact |
|-----|--------|--------|
| Prometheus / OpenTelemetry metrics export | Medium | Medium — production monitoring |
| CSRF protection plugin | Medium | Medium — security best practice |
| TLS/HTTPS in `serve()` | Medium | Low — most use reverse proxy |
| HTTP/2 support | High | Low — most use reverse proxy |
| Cluster mode | Medium | Low — PM2/Docker handles this |
| Multi-environment config profiles | Low | Low — nice for DX |
| Regex route patterns | Medium | Low — rarely needed |
| Template engine integration | Medium | Low — niche use case for API frameworks |
