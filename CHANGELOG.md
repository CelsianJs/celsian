# Changelog

All notable changes to CelsianJS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.x] - 2026-05-10

### Release status

- Current published package line uses mixed `0.3.x` versions managed by Changesets. Root changelog entries below summarize the line; package-specific release notes remain in Changesets and npm metadata.

### Added

- Package publish smoke verification for packed artifacts and post-publish npm registry installs.
- CI package-smoke job and private release assertions for platform/edge-router/example packages.

### Changed

- Release verification now fails if private deployment-platform packages or examples are accidentally made publishable.

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
