# CelsianJS Milestones

**Baseline:** 12 packages, 29 test files, 227 tests passing, clean TypeScript build.
**Last verified:** 2026-02-15

---

## Milestone 1: Production Hardening

**Goal:** Make CelsianJS safe to run under hostile traffic. Every HTTP server in production needs body limits, timeouts, security headers, and robust error handling. Today the framework parses bodies without size limits and has no request timeout mechanism.

**Priority:** P0 (must-have before any real production use)

### 1.1 Body Size Limits

**Priority:** P0 | **Complexity:** M | **Depends on:** None

**Current state:** `packages/core/src/app.ts` lines 371-389 (`parseBody`) calls `request.json()`, `request.formData()`, and `request.text()` without checking `Content-Length` or enforcing a byte limit. A malicious client can send a 10 GB JSON body and OOM the process.

**Tasks:**
- Add `bodyLimit` option to `CelsianAppOptions` in `packages/core/src/types.ts` (default: `1_048_576` / 1 MB)
- Add `bodyLimit` to `CelsianConfig.server` in `packages/core/src/config.ts`
- Create `packages/core/src/body-parser.ts` that:
  - Checks `Content-Length` header against limit before reading
  - For streamed bodies without `Content-Length`, reads incrementally and aborts if limit exceeded
  - Throws `HttpError(413, 'Payload Too Large')` on overflow
- Replace the inline `parseBody()` method in `packages/core/src/app.ts` with the new module
- Allow per-route body limit overrides via `RouteOptions.bodyLimit` in `packages/core/src/types.ts`
- Tests in `packages/core/test/body-parser.test.ts`:
  - Rejects body exceeding limit (413 response)
  - Accepts body within limit
  - Works with `Content-Length` header present and absent
  - Per-route override works
  - Streams abort mid-read when limit exceeded

**Definition of done:** A test sending a 2 MB JSON body to a route with 1 MB limit returns 413. The default applies globally, and per-route overrides work.

### 1.2 Request Timeouts

**Priority:** P0 | **Complexity:** M | **Depends on:** None

**Current state:** `packages/core/src/app.ts` `runLifecycle()` (lines 288-339) has no timeout. A slow database query or hung upstream call will hold the connection forever.

**Tasks:**
- Add `requestTimeout` option to `CelsianAppOptions` in `packages/core/src/types.ts` (default: `30_000` ms)
- Add `requestTimeout` to `CelsianConfig.server` in `packages/core/src/config.ts`
- In `packages/core/src/app.ts` `handle()`, wrap `runLifecycle()` in `Promise.race` with an `AbortSignal.timeout()`:
  - On timeout, return `HttpError(408, 'Request Timeout')` response
  - Cancel in-flight work via AbortSignal
- Expose `request.signal` (the AbortSignal) so handlers can check `signal.aborted` or pass it to fetch calls
- Allow per-route timeout via `RouteOptions.timeout`
- Tests in `packages/core/test/timeout.test.ts`:
  - Handler that sleeps 500ms with a 100ms timeout returns 408
  - Handler that completes in 50ms with a 100ms timeout returns 200
  - Per-route timeout override works
  - AbortSignal is propagated to handler

**Definition of done:** A slow handler times out with 408, the AbortSignal is available to handlers, and per-route overrides work.

### 1.3 Security Headers (Helmet-style)

**Priority:** P1 | **Complexity:** S | **Depends on:** None

**Current state:** No security headers are set by default. CORS is a plugin (`packages/core/src/plugins/cors.ts`), but there is nothing for CSP, HSTS, X-Frame-Options, etc.

**Tasks:**
- Create `packages/core/src/plugins/helmet.ts` implementing a `helmet()` plugin function
- Default headers to set:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `X-XSS-Protection: 0` (modern best practice: disable the buggy XSS auditor)
  - `Strict-Transport-Security: max-age=15552000; includeSubDomains`
  - `Content-Security-Policy: default-src 'self'`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `X-DNS-Prefetch-Control: off`
- All headers configurable via options, each individually disableable
- Register as `onSend` hook (same pattern as CORS plugin)
- Export from `packages/core/src/index.ts`
- Tests in `packages/core/test/helmet.test.ts`:
  - Default headers present
  - Individual header overrides
  - Disabling specific headers

**Definition of done:** `app.register(helmet())` sets all default security headers. Each header is individually configurable and disableable.

### 1.4 Health Check and Readiness Probes

**Priority:** P1 | **Complexity:** S | **Depends on:** None

**Current state:** Health checks must be manually defined by users. The `examples/basic/src/index.ts` shows a hand-written `/health` route.

**Tasks:**
- Create `packages/core/src/plugins/health.ts` with a `healthCheck()` plugin
- Options: `path` (default `/health`), `readyPath` (default `/ready`), custom `check` function
- Health endpoint returns `{ status: 'ok', uptime, timestamp }`
- Readiness endpoint runs user-provided `check()` async function (e.g., database ping) and returns `{ status: 'ready' }` or 503 `{ status: 'not_ready' }`
- Export from `packages/core/src/index.ts`
- Tests in `packages/core/test/health.test.ts`:
  - Default health returns 200
  - Readiness with passing check returns 200
  - Readiness with failing check returns 503
  - Custom paths work

**Definition of done:** `app.register(healthCheck())` adds two endpoints. Kubernetes liveness/readiness probes work out of the box.

### 1.5 Body Parsing Edge Cases

**Priority:** P1 | **Complexity:** M | **Depends on:** 1.1

**Current state:** `parseBody()` in `packages/core/src/app.ts` handles JSON, form-urlencoded, multipart/form-data, and text. But multipart is delegated entirely to `request.formData()`, which works differently across runtimes. Stream bodies are not handled.

**Tasks:**
- Handle `application/octet-stream` content type (set `parsedBody` to `ReadableStream`)
- Handle missing content-type gracefully (attempt JSON parse, fall back to text)
- Handle malformed JSON with a proper 400 error instead of silently swallowing the error
- Handle duplicate content-type headers
- Support `charset` parameter in content-type
- Tests in `packages/core/test/body-parser.test.ts` (extend from 1.1):
  - Malformed JSON returns 400 with error message
  - Missing content-type attempts JSON parse
  - Binary body available as stream
  - Empty body for POST returns undefined parsedBody

**Definition of done:** Body parsing handles all common content types gracefully, malformed input returns structured 400 errors, and binary streaming works.

### 1.6 Error Serialization Improvements

**Priority:** P1 | **Complexity:** S | **Depends on:** None

**Current state:** `packages/core/src/errors.ts` has `HttpError` and `ValidationError` with `toJSON()`. But the default error handler in `packages/core/src/app.ts` (lines 391-432) exposes raw error messages to clients in production, which is a security risk.

**Tasks:**
- Add `NODE_ENV` / `CELSIAN_ENV` awareness to error serialization
- In production mode, suppress internal error messages for 500s (show `"Internal Server Error"` only)
- In development mode, include stack traces in error responses
- Add `cause` chain support: if error has a `cause`, include it in dev mode serialization
- Add `code` field to `HttpError` (e.g., `NOT_FOUND`, `VALIDATION_FAILED`) for programmatic error handling
- Tests in `packages/core/test/errors.test.ts` (extend existing):
  - Production mode hides 500 error details
  - Development mode includes stack trace
  - Error codes are present on all HttpError instances

**Definition of done:** Errors are safe for production (no internal details leaked), helpful in development (stack traces), and programmatically identifiable (error codes).

---

## Milestone 2: Performance

**Goal:** Establish benchmarks, identify bottlenecks, and optimize the hot path. CelsianJS should be competitive with Fastify and Hono.

**Priority:** P1 (should-have for credibility)

### 2.1 Benchmark Suite

**Priority:** P0 | **Complexity:** M | **Depends on:** None

**Tasks:**
- Create `benchmarks/` directory at project root
- `benchmarks/suite.ts` — autocannon-based benchmark runner
- Benchmark scenarios:
  - JSON serialization (`GET /json` returning `{ message: 'Hello, World!' }`)
  - URL parameter parsing (`GET /users/:id`)
  - Body parsing (`POST /json` with 100-byte JSON body)
  - Middleware chain (3 hooks + handler)
  - Schema validation (TypeBox + body)
  - No-op passthrough (measure framework overhead)
- Compare against baseline numbers from Fastify, Hono, and Elysia (documented in `benchmarks/README.md`)
- `npm run bench` script in root `package.json`
- Output results as JSON + markdown table

**Definition of done:** `npm run bench` runs all scenarios and outputs a comparable table. Results can be tracked over time.

### 2.2 Router Optimization

**Priority:** P1 | **Complexity:** M | **Depends on:** 2.1

**Current state:** `packages/core/src/router.ts` uses a radix tree. For every request, it splits the pathname on `/` (line 137-139) and recursively walks nodes. This is allocating arrays and making recursive calls per request.

**Tasks:**
- Pre-compile static routes into a `Map<string, InternalRoute>` for O(1) lookup (the common case)
- Only fall through to radix tree matching for parameterized/wildcard routes
- Avoid `path.split('/').filter(Boolean)` allocation on every request (pre-parse at registration time)
- Consider compiling the match function for frequently-hit routes
- Benchmark before/after with the suite from 2.1
- Tests: all existing `packages/core/test/router.test.ts` must still pass

**Definition of done:** Static route matching is O(1) via Map lookup. Benchmark shows measurable improvement for the JSON serialization scenario.

### 2.3 Request/Response Object Pooling

**Priority:** P2 | **Complexity:** L | **Depends on:** 2.1

**Current state:** `packages/core/src/request.ts` `buildRequest()` creates a new object with getters for every request. `packages/core/src/reply.ts` `createReply()` creates a new closure-based object every request.

**Tasks:**
- Investigate whether object pooling is feasible with the Web API Request/Response model
- If feasible: implement a pool for CelsianReply objects (reset state between uses)
- If not: document why and identify other allocation hotspots
- Profile memory allocation with `--expose-gc` and `gc()` between benchmark runs
- Benchmark before/after

**Definition of done:** Either measurable allocation reduction, or a documented analysis of why pooling is not applicable.

### 2.4 Memory Leak Testing

**Priority:** P1 | **Complexity:** M | **Depends on:** 2.1

**Tasks:**
- Create `benchmarks/memory.ts` — sustained load test (60 seconds at 1000 req/s)
- Measure RSS before, during, and after
- Check that RSS stabilizes (not monotonically increasing)
- Test with:
  - Plain routes
  - Routes with hooks
  - Routes with schema validation
  - Routes with CORS, compression, and rate limiting enabled
- Run in CI (GitHub Actions) on every PR

**Definition of done:** 60-second sustained load shows RSS stabilization. No monotonic growth.

### 2.5 Comparative Benchmarks

**Priority:** P2 | **Complexity:** S | **Depends on:** 2.1

**Tasks:**
- Write equivalent "hello world" and "JSON CRUD" apps in Fastify, Hono, and Elysia
- Run same autocannon scenarios against all frameworks
- Document results in `benchmarks/RESULTS.md`
- Identify any scenarios where CelsianJS is >2x slower, file issues for those

**Definition of done:** Documented comparison. CelsianJS within 2x of Fastify on all scenarios, or issues filed for outliers.

---

## Milestone 3: Database Integration

**Goal:** Provide patterns and utilities for connecting CelsianJS to databases. Not an ORM, but production-ready integration patterns.

**Priority:** P1 (should-have for real-world use)

### 3.1 Connection Pool Management Pattern

**Priority:** P0 | **Complexity:** M | **Depends on:** None

**Tasks:**
- Create `packages/core/src/plugins/database.ts` with a `database()` plugin
- Plugin accepts a `createPool()` factory function and decorates the app with `db`
- Graceful shutdown: close pool on `onShutdown` (integrate with `packages/core/src/serve.ts` lines 126-149)
- Pool health check: expose `db.isHealthy()` for readiness probe integration
- Type-safe decoration: augment `CelsianRequest` interface for `req.db`
- Example with `pg` pool in `examples/database/src/index.ts`
- Tests using an in-memory SQLite or mock pool

**Definition of done:** `app.register(database({ createPool: () => pgPool }))` decorates the app. Pool closes on shutdown. Health check available.

### 3.2 Drizzle ORM Integration Example

**Priority:** P1 | **Complexity:** M | **Depends on:** 3.1

**Tasks:**
- Create `examples/drizzle/` with a full CRUD API using Drizzle + SQLite
- Show schema definition, migration, and query patterns
- Demonstrate transaction usage within a request handler
- Include `README.md` with setup instructions

**Definition of done:** Runnable example with `npm run dev` that has CRUD operations using Drizzle.

### 3.3 Prisma Integration Example

**Priority:** P2 | **Complexity:** M | **Depends on:** 3.1

**Tasks:**
- Create `examples/prisma/` with a full CRUD API using Prisma + SQLite
- Show Prisma schema, migration, and query patterns
- Demonstrate Prisma Client lifecycle (connect/disconnect)
- Include `README.md` with setup instructions

**Definition of done:** Runnable example with `npm run dev` that has CRUD operations using Prisma.

### 3.4 Transaction Middleware Pattern

**Priority:** P1 | **Complexity:** S | **Depends on:** 3.1

**Tasks:**
- Create a `withTransaction()` hook factory in the database plugin
- Usage: `app.route({ preHandler: withTransaction(), handler: (req, reply) => { req.tx.query(...) } })`
- Auto-commit on success, auto-rollback on error
- Works with any pool that supports `BEGIN`/`COMMIT`/`ROLLBACK`
- Tests with mock transaction

**Definition of done:** Transaction middleware commits on success, rolls back on error, and integrates with the existing hook system.

### 3.5 Migration CLI Integration

**Priority:** P2 | **Complexity:** M | **Depends on:** 3.1

**Tasks:**
- Add `celsian migrate` command to `packages/cli/src/index.ts`
- Subcommands: `celsian migrate up`, `celsian migrate down`, `celsian migrate status`
- Delegates to the configured ORM's migration runner (Drizzle Kit or Prisma Migrate)
- Auto-detect ORM from `package.json` dependencies
- Add to CLI help text

**Definition of done:** `celsian migrate up` runs pending migrations. Works with Drizzle Kit out of the box.

---

## Milestone 4: Deployment Targets (E2E)

**Goal:** Prove CelsianJS works on every major deployment target with real, deployable examples and end-to-end tests.

**Priority:** P1 (should-have for adoption)

### 4.1 Cloudflare Workers Deploy Example

**Priority:** P0 | **Complexity:** M | **Depends on:** None

**Current state:** `packages/adapter-cloudflare/src/index.ts` exists with `createCloudflareHandler()`. Tests pass with mocks but no real deployment has been tested.

**Tasks:**
- Create `examples/cloudflare-worker/` directory
- `wrangler.toml` configuration
- `src/index.ts` using `createCloudflareHandler(app)`
- `build.mjs` script (esbuild bundle, similar to `examples/vercel-edge/build.mjs`)
- Show KV binding usage (read/write to Cloudflare KV)
- `README.md` with deploy instructions (`wrangler deploy`)
- Test local dev with `wrangler dev`

**Definition of done:** `wrangler deploy` from the example directory deploys successfully. Health endpoint returns 200. KV read/write works.

### 4.2 AWS Lambda Deploy Example

**Priority:** P0 | **Complexity:** M | **Depends on:** None

**Current state:** `packages/adapter-lambda/src/index.ts` exists with `createLambdaHandler()`. Tests pass with mock events.

**Tasks:**
- Create `examples/aws-lambda/` directory
- SAM template (`template.yaml`) for API Gateway v2 + Lambda
- `src/handler.ts` using `createLambdaHandler(app)`
- `build.mjs` script (esbuild bundle to single file for Lambda)
- Include `samconfig.toml` for deployment defaults
- `README.md` with deploy instructions (`sam deploy`)
- Show cold start optimization (lazy imports, minimal bundle)

**Definition of done:** `sam deploy` creates a working API Gateway + Lambda stack. Health endpoint returns 200 within 500ms cold start.

### 4.3 Docker Deployment Example

**Priority:** P1 | **Complexity:** S | **Depends on:** None

**Tasks:**
- Create `examples/docker/` directory
- Multi-stage `Dockerfile` (build + run stages)
- `docker-compose.yml` with the API + optional Postgres
- `.dockerignore` file
- Health check in Dockerfile (`HEALTHCHECK CMD curl -f http://localhost:3000/health`)
- `README.md` with `docker compose up` instructions

**Definition of done:** `docker compose up` starts the API. Health check passes. Image size under 100 MB.

### 4.4 Railway/Fly.io Deploy Example

**Priority:** P2 | **Complexity:** S | **Depends on:** None

**Tasks:**
- Create `examples/fly-io/` directory
- `fly.toml` configuration
- `Dockerfile` (can share pattern from 4.3)
- `README.md` with `fly deploy` instructions
- Show environment variable configuration

**Definition of done:** `fly deploy` creates a working deployment. Health endpoint returns 200.

### 4.5 E2E Deployment Tests

**Priority:** P1 | **Complexity:** L | **Depends on:** 4.1, 4.2

**Tasks:**
- Create `e2e/` directory at project root
- `e2e/deploy-test.ts` — script that:
  - Deploys to a target (Vercel/Cloudflare/Lambda via CLI)
  - Hits the live health endpoint
  - Sends a POST request and verifies response
  - Verifies CORS headers
  - Tears down deployment
- GitHub Actions workflow that runs E2E on merge to main
- Use environment secrets for deployment credentials
- Timeout: 5 minutes per target

**Definition of done:** CI runs E2E deployment tests on merge. At least Vercel Edge (already deployed to `vercel-edge-ten-rho.vercel.app`) and one other target pass.

---

## Milestone 5: Real-World Testing

**Goal:** Validate that CelsianJS handles real-world patterns: queues, WebSockets, authentication flows, full CRUD.

**Priority:** P1 (should-have for confidence)

### 5.1 Redis Queue Backend

**Priority:** P0 | **Complexity:** M | **Depends on:** None

**Current state:** `packages/core/src/queue.ts` defines the `QueueBackend` interface. Only `MemoryQueue` is implemented. Production workloads need Redis.

**Tasks:**
- Create `packages/queue-redis/` package
- Implement `RedisQueue` class satisfying `QueueBackend` interface from `packages/core/src/queue.ts`
- Use `ioredis` as the Redis client
- Redis operations:
  - `push()` — `LPUSH` to task queue list
  - `pop()` — `BRPOPLPUSH` to in-flight list with visibility timeout
  - `ack()` — `LREM` from in-flight list
  - `nack()` — move back to task queue with delay (using sorted set)
  - `size()` — `LLEN`
- Connection management: accept existing Redis client or create new one
- Graceful shutdown: close Redis connection
- Tests using a real Redis instance (skip if `REDIS_URL` not set) or a mock

**Definition of done:** `app.queue = new RedisQueue({ url: process.env.REDIS_URL })` works as a drop-in replacement for `MemoryQueue`. Tasks survive process restarts.

### 5.2 WebSocket E2E Tests

**Priority:** P1 | **Complexity:** M | **Depends on:** None

**Current state:** `packages/core/src/websocket.ts` has `WSRegistry` and `WSConnection` with unit tests for the registry. But there are no integration tests that open actual WebSocket connections.

**Tasks:**
- Create `packages/core/test/websocket-e2e.test.ts`
- Start a real server (using `serve()` from `packages/core/src/serve.ts`)
- Use a WebSocket client (native `ws` or `undici`) to:
  - Connect to a registered path
  - Send a message and receive an echo
  - Test broadcast to multiple connections
  - Test connection close handler
  - Test connection with metadata
- Integrate WebSocket upgrade handling in `serve()` Node.js server
- Clean up: close server after tests

**Definition of done:** WebSocket connections work end-to-end in Node.js. Client connects, sends messages, receives broadcasts, and disconnects cleanly.

### 5.3 Full CRUD API Example with Database

**Priority:** P1 | **Complexity:** M | **Depends on:** 3.1

**Tasks:**
- Create `examples/crud-api/` directory
- Full CRUD for a "todos" resource:
  - `GET /todos` — list all
  - `GET /todos/:id` — get one
  - `POST /todos` — create (with TypeBox validation)
  - `PUT /todos/:id` — update
  - `DELETE /todos/:id` — delete
- Use SQLite + Drizzle for persistence
- Include pagination, sorting, filtering on list endpoint
- Include error handling (404 for missing, 400 for invalid input)
- Test file `examples/crud-api/test/api.test.ts` using `app.inject()`

**Definition of done:** Runnable CRUD API with 10+ integration tests. All CRUD operations work with validation.

### 5.4 Authentication Flow Example (JWT + Refresh Tokens)

**Priority:** P1 | **Complexity:** M | **Depends on:** None

**Current state:** `packages/jwt/src/index.ts` has `jwt()` plugin and `createJWTGuard()`. But there is no example of a complete auth flow with refresh tokens.

**Tasks:**
- Create `examples/auth-flow/` directory
- Endpoints:
  - `POST /auth/register` — create user (hashed password)
  - `POST /auth/login` — return access token (15 min) + refresh token (7 days)
  - `POST /auth/refresh` — exchange refresh token for new access token
  - `POST /auth/logout` — invalidate refresh token
  - `GET /auth/me` — return current user (protected route)
- Use `@celsian/jwt` for token signing/verification
- Refresh tokens stored in a Map (demonstrate the pattern; note Redis for production)
- Password hashing with `node:crypto` (scrypt)
- Include `createJWTGuard()` on protected routes
- Test file with inject-based tests

**Definition of done:** Complete auth flow example with register, login, refresh, logout, and protected endpoint. All endpoints tested.

### 5.5 Rate Limiting with Redis Store

**Priority:** P2 | **Complexity:** S | **Depends on:** 5.1

**Current state:** `packages/rate-limit/src/index.ts` defines `RateLimitStore` interface. Only `MemoryRateLimitStore` is implemented.

**Tasks:**
- Create `packages/rate-limit-redis/` package (or add Redis store to existing package)
- Implement `RedisRateLimitStore` satisfying `RateLimitStore` interface
- Use Redis `INCR` + `EXPIRE` for sliding window (or `MULTI`/`EXEC` for atomic increment-and-check)
- Accept existing Redis client
- Tests using real Redis (skip if `REDIS_URL` not set) or mock

**Definition of done:** `rateLimit({ store: new RedisRateLimitStore({ url }) })` works as a drop-in replacement. Rate limits are shared across multiple server instances.

---

## Milestone 6: DX Polish

**Goal:** Make the developer experience delightful. Better CLI, better error messages, better types, auto-generated docs.

**Priority:** P2 (nice-to-have for v1.0)

### 6.1 CLI `celsian build` Command

**Priority:** P1 | **Complexity:** M | **Depends on:** None

**Current state:** `packages/cli/src/index.ts` has `dev`, `create`, `generate`, and `routes` commands. There is no `build` command. The Vercel example uses a custom `build.mjs` with esbuild.

**Tasks:**
- Add `build` command to `packages/cli/src/commands/build.ts`
- Use esbuild to bundle the entry point into a single file
- Options:
  - `--entry` (default `src/index.ts`)
  - `--outdir` (default `dist/`)
  - `--format` (default `esm`)
  - `--target` (default `es2022`)
  - `--minify` (default `false`)
  - `--platform` (default `node`, also `browser` for edge runtimes)
- Register in `packages/cli/src/index.ts` switch statement
- Add `build` to CLI help text

**Definition of done:** `celsian build` bundles the app into a single file. `node dist/index.js` starts the server.

### 6.2 CLI `celsian deploy` Command

**Priority:** P2 | **Complexity:** L | **Depends on:** 6.1

**Tasks:**
- Add `deploy` command to `packages/cli/src/commands/deploy.ts`
- Auto-detect target from:
  - `vercel.json` present -> Vercel
  - `wrangler.toml` present -> Cloudflare
  - `fly.toml` present -> Fly.io
  - `Dockerfile` present -> Docker (just build)
  - `template.yaml` present -> AWS SAM
- Run the appropriate deploy CLI (`vercel`, `wrangler deploy`, `fly deploy`, `sam deploy`)
- Pre-deploy: run `celsian build` with appropriate platform settings
- Register in CLI and help text

**Definition of done:** `celsian deploy` detects the target and deploys. Works for at least Vercel and Cloudflare targets.

### 6.3 Better Error Messages with Suggestions

**Priority:** P1 | **Complexity:** S | **Depends on:** None

**Tasks:**
- When a route handler throws a non-Error value, wrap it and suggest `throw new HttpError()`
- When `app.register()` receives a non-function, show what was received and suggest the correct pattern
- When body parsing fails, include the content-type that was received
- When schema validation fails, format issues as a readable list (not just raw JSON)
- When a plugin tries to decorate with a name that already exists, show both the old and new values
- Collect all suggestions in `packages/core/src/errors.ts` as static helper methods
- Tests for each suggestion scenario

**Definition of done:** Common mistakes produce error messages that include "Did you mean...?" or "Try..." suggestions.

### 6.4 TypeScript Plugin for Route Type Inference

**Priority:** P2 | **Complexity:** L | **Depends on:** None

**Tasks:**
- Research feasibility of a TypeScript language service plugin
- Goal: when `app.get('/users/:id', (req, reply) => { ... })`, `req.params` should be typed as `{ id: string }`
- Investigate:
  - Template literal type extraction from URL strings
  - Augmenting `CelsianRequest` based on route schema
- If feasible: create `packages/typescript-plugin/`
- If not feasible: document a `defineRoute()` helper that provides type inference through generics

**Definition of done:** Either a working TypeScript plugin that infers param types from URL patterns, or a `defineRoute()` helper with full type safety.

### 6.5 Auto-Generated API Documentation (OpenAPI)

**Priority:** P1 | **Complexity:** M | **Depends on:** None

**Current state:** `packages/rpc/src/openapi.ts` generates OpenAPI 3.1 specs for RPC routes. But REST routes defined via `app.get()` / `app.post()` have no OpenAPI generation.

**Tasks:**
- Create `packages/core/src/plugins/openapi.ts` with an `openapi()` plugin
- Collect all registered routes from `app.getRoutes()` (from `packages/core/src/app.ts` line 282)
- For routes with `schema.body`, `schema.querystring`, `schema.params`, and `schema.response`, extract JSON Schema via `toJsonSchema()`
- Generate OpenAPI 3.1 spec from all routes
- Serve at `GET /docs/openapi.json`
- Optionally serve Swagger UI at `GET /docs` (embed Swagger UI HTML)
- Integrate with the existing RPC OpenAPI generation (merge specs if both REST and RPC routes exist)
- Export from `packages/core/src/index.ts`
- Tests:
  - Spec includes routes with schemas
  - Spec includes correct HTTP methods and paths
  - Routes without schemas appear with minimal info
  - Swagger UI HTML is served

**Definition of done:** `app.register(openapi())` serves a combined OpenAPI spec at `/docs/openapi.json` covering both REST and RPC routes.

---

## Dependency Graph

```
Milestone 1 (Production Hardening)
  1.1 Body Size Limits ──────────────> 1.5 Body Parsing Edge Cases
  1.2 Request Timeouts
  1.3 Security Headers (Helmet)
  1.4 Health Check / Readiness
  1.6 Error Serialization

Milestone 2 (Performance)
  2.1 Benchmark Suite ──────────────> 2.2 Router Optimization
                      ──────────────> 2.3 Object Pooling
                      ──────────────> 2.4 Memory Leak Testing
                      ──────────────> 2.5 Comparative Benchmarks

Milestone 3 (Database)
  3.1 Connection Pool ──────────────> 3.2 Drizzle Example
                      ──────────────> 3.3 Prisma Example
                      ──────────────> 3.4 Transaction Middleware
                      ──────────────> 3.5 Migration CLI

Milestone 4 (Deployment)
  4.1 Cloudflare Workers ───────────> 4.5 E2E Tests
  4.2 AWS Lambda ───────────────────> 4.5 E2E Tests
  4.3 Docker
  4.4 Railway/Fly.io

Milestone 5 (Real-World)
  5.1 Redis Queue ──────────────────> 5.5 Rate Limit Redis
  5.2 WebSocket E2E
  5.3 CRUD Example (depends on 3.1)
  5.4 Auth Flow Example

Milestone 6 (DX Polish)
  6.1 CLI Build ────────────────────> 6.2 CLI Deploy
  6.3 Better Error Messages
  6.4 TypeScript Plugin
  6.5 OpenAPI for REST Routes
```

---

## Execution Order (Recommended)

**Phase 1 — Foundation (Weeks 1-2):**
- 1.1 Body Size Limits (P0)
- 1.2 Request Timeouts (P0)
- 1.6 Error Serialization (P1)
- 2.1 Benchmark Suite (P0)

**Phase 2 — Harden & Measure (Weeks 3-4):**
- 1.3 Security Headers (P1)
- 1.4 Health Check (P1)
- 1.5 Body Parsing Edge Cases (P1)
- 2.2 Router Optimization (P1)
- 2.4 Memory Leak Testing (P1)

**Phase 3 — Real-World Patterns (Weeks 5-7):**
- 3.1 Connection Pool (P0)
- 5.1 Redis Queue (P0)
- 5.2 WebSocket E2E (P1)
- 5.4 Auth Flow Example (P1)
- 4.1 Cloudflare Workers (P0)
- 4.2 AWS Lambda (P0)

**Phase 4 — Polish (Weeks 8-10):**
- 6.1 CLI Build (P1)
- 6.3 Better Error Messages (P1)
- 6.5 OpenAPI for REST (P1)
- 3.2 Drizzle Example (P1)
- 3.4 Transaction Middleware (P1)
- 5.3 CRUD Example (P1)
- 4.3 Docker (P1)
- 4.5 E2E Tests (P1)

**Phase 5 — Nice to Have (Ongoing):**
- 2.3 Object Pooling (P2)
- 2.5 Comparative Benchmarks (P2)
- 3.3 Prisma Example (P2)
- 3.5 Migration CLI (P2)
- 4.4 Railway/Fly.io (P2)
- 5.5 Rate Limit Redis (P2)
- 6.2 CLI Deploy (P2)
- 6.4 TypeScript Plugin (P2)

---

## File Index

All file paths referenced in this plan, organized by package:

**packages/core/src/**
- `app.ts` — Main application class, request handling, lifecycle
- `router.ts` — Radix tree router
- `request.ts` — Request builder (Web API delegation)
- `reply.ts` — Reply builder (JSON, HTML, stream, redirect, cookies)
- `serve.ts` — Node/Bun/Deno server with graceful shutdown
- `hooks.ts` — Hook store, execution, cloning
- `errors.ts` — HttpError, ValidationError, CelsianError
- `config.ts` — Config loading and merging
- `types.ts` — All type definitions
- `context.ts` — Encapsulation context for plugin isolation
- `inject.ts` — Test injection utility
- `logger.ts` — Structured JSON logger
- `cookie.ts` — Cookie parsing and serialization
- `queue.ts` — QueueBackend interface + MemoryQueue
- `task.ts` — Task system (registry, worker, enqueue)
- `cron.ts` — Cron scheduler
- `websocket.ts` — WebSocket registry and connections
- `plugins/cors.ts` — CORS plugin
- `index.ts` — Package exports

**packages/schema/src/**
- `standard.ts` — StandardSchema interface
- `detect.ts` — Auto-detect schema library
- `coerce.ts` — Type coercion for query params
- `adapters/zod.ts`, `adapters/typebox.ts`, `adapters/valibot.ts`

**packages/rpc/src/**
- `router.ts` — RPC router + handler execution
- `procedure.ts` — Procedure builder
- `client.ts` — Type-safe RPC client proxy
- `wire.ts` — Tagged wire encoding (Date, BigInt, Set, Map, RegExp)
- `openapi.ts` — OpenAPI 3.1 generation
- `types.ts` — RPC type definitions

**packages/cli/src/**
- `index.ts` — CLI entry point
- `commands/dev.ts` — Dev server with file watching
- `commands/create.ts` — Project scaffolder
- `commands/generate.ts` — Route/RPC generators
- `commands/routes.ts` — Route listing

**packages/jwt/src/index.ts** — JWT plugin + guard
**packages/rate-limit/src/index.ts** — Rate limiter + MemoryStore
**packages/compress/src/index.ts** — Response compression
**packages/adapter-vercel/src/index.ts** — Vercel serverless + edge handlers
**packages/adapter-lambda/src/index.ts** — AWS Lambda API Gateway v2 handler
**packages/adapter-cloudflare/src/index.ts** — Cloudflare Workers handler
**packages/celsian/src/index.ts** — Meta-package re-exports
**packages/create-celsian/src/index.ts** — Standalone scaffolder

**examples/**
- `basic/` — Minimal API
- `rest-api/` — REST + TypeBox
- `rpc-api/` — RPC-first
- `vercel-edge/` — Deployed Vercel Edge example
