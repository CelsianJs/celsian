# @celsian/core

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
