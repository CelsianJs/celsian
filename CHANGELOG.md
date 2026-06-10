# Changelog

All notable changes to CelsianJS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 0.5.2

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
- **CI:** real npm provenance, concurrency cancellation, blocking Bun/Deno jobs, a
  workerd smoke job, and `size-limit` budgets.

### Fixed
- **CRITICAL — core:** `serve()` loopback-only bind (see behavior changes); now logs the bound address.
- **CRITICAL — cli:** `celsian routes` crashed in every project (tsx `--eval` top-level-await under CJS); rewritten to a temp `.mts` loader that surfaces real errors.
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
- **site:** updated marketing site for 0.5.1 — current performance numbers, version, all 8 adapters, fixed `/docs` link.

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
- **jwt:** lazy `createJWTGuard()` resolves each app's secret/algorithms from the request — fixes
  cross-app secret bleed and honors configured algorithms.

### Fixed
- **core:** invalid cron fields (`*/0`, NaN, out-of-range) throw instead of hanging the event loop;
  request timeout now aborts the handler via `request.signal`; malformed/oversized bodies return
  400/413; errors route through the structured logger.
- **queue-redis:** atomic pop (Lua) with an in-flight reaper honoring `visibilityTimeout`; ioredis
  `error` listeners prevent process crashes during a Redis outage. (Key schema `:inflight` →
  `:processing`/`:stamps` — drain in-flight messages before upgrading.)
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

- **RPC module** (`@celsian/rpc`): Type-safe remote procedure calls with client generation and OpenAPI output
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
