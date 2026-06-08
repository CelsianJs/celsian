# Changelog

All notable changes to CelsianJS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
