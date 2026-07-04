# @celsian/core

## 0.5.3

### Patch Changes

- a60b3e4: Production-readiness DX fixes and dependency maintenance (0.5.3).

  - **@celsian/core (fail-loud config):** `loadConfig()` no longer swallows a broken `celsian.config.*` with a bare `catch`. A genuinely absent config still falls back to defaults, but a config that exists and fails to load (syntax/runtime error, or a missing import it depends on) now throws the new exported `ConfigLoadError` naming the file and cause. `serve()` surfaces it instead of silently binding defaults — fixing the "why won't my config apply" black hole where a typo in the config left the server on port 3000 with no diagnostic.
  - **@celsian/cli (`celsian dev`):** checks the entry file exists before spawning `tsx`, printing `Entry file not found: <entry>` plus usage (mirroring `celsian routes`) instead of a raw "Cannot find module" stack trace on first run.
  - **@celsian/cli (`celsian generate rpc`):** now scaffolds a mountable, type-correct starting point — wrapped in `router()`, exported as a registerable `PluginFunction` that calls `new RPCHandler(...).mount(app)`, with `.input(schema)` guidance — instead of a bare object that had no path to a live endpoint and destructured an always-`undefined` `input`.
  - **@celsian/jwt:** bump `jose` `5.10.0` → `6.2.2` (major). No API changes; sign/verify/expiry/algorithm selection and cross-app guard isolation are all covered by the existing jwt test suite under jose 6.
  - **@celsian/ws-redis, @celsian/queue-redis:** bump `ioredis` `5.9.3` → `5.11.1` (minor).
  - @celsian/schema@0.5.3

## 0.5.2

### Patch Changes

- 05eb2b4: Core hardening (0.5.2).

  **Behavior changes — read before upgrading:**

  - **Production now binds `0.0.0.0`.** `serve()` previously always bound `localhost`
    (IPv6 `::1`), making the server unreachable from a Docker/Fly/Railway port map.
    It now binds `0.0.0.0` when `NODE_ENV=production` (still `localhost` in dev),
    after honoring an explicit `host` option or `HOST` env var. If you relied on
    loopback-only binding in production, set `host`/`HOST` to `127.0.0.1` explicitly.
  - **CSRF `excludePaths` now match by path segment.** An entry like `/api` previously
    matched only the exact path `/api`; it now also exempts `/api/...` (but not
    `/apix`). This widens existing exclusions — review your `excludePaths` lists.

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
