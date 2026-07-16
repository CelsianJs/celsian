# @celsian/rate-limit

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

- 05eb2b4: Security hardening across rate-limit, rpc, and jwt:

  - **@celsian/rate-limit (SECURITY, behavior change):** with `trustProxy: true`, the default key is now taken from X-Forwarded-For counting `trustedProxyHops` (new option, default `1`) from the RIGHT instead of using the leftmost entry. The leftmost XFF value is client-supplied — rotating it per request fully bypassed rate limiting and flooded the store with unique keys. With one trusted proxy the keyed IP is the last entry (what your proxy appended); set `trustedProxyHops` to your actual proxy depth, or keep using a custom `keyGenerator`. Note: deployments behind multiple proxies that relied on the old leftmost behavior will now key a different IP — this is intentional.
  - **@celsian/rate-limit (SECURITY):** `MemoryRateLimitStore` now enforces a max-keys cap (`maxKeys` option, default `100_000`, also exposed on `rateLimit()` options) with expired-first/oldest-first eviction so spoofed-key floods can no longer exhaust memory.
  - **@celsian/rate-limit (fail-closed):** `rateLimit()` now throws a `CelsianError` at registration when `window` or `max` is missing/NaN/non-positive. Previously an invalid `window` (e.g. passing `windowMs`) made every bucket's `resetAt` NaN and silently disabled rate limiting (fail open).
  - **@celsian/rpc (SECURITY):** unexpected (5xx-equivalent) procedure errors no longer leak raw `error.message`/`error.code` to clients when `NODE_ENV`/`CELSIAN_ENV` is `production` — they return a generic `INTERNAL_ERROR` body (mirroring `@celsian/core`'s error-handler sanitization) and are always logged server-side. Full detail is preserved in development, and intentional HTTP-style errors (`statusCode < 500`) pass through unchanged.
  - **@celsian/rpc:** new `rpc.mount(app, prefix?)` helper registers both `GET` and `POST` wildcard routes on a Celsian app (the client uses GET for queries and POST for mutations). The README previously documented `app.all(...)`, which `CelsianApp` does not have; `mount()` is now the documented primary path.
  - **@celsian/jwt:** registering with an HS\* secret shorter than 32 bytes now emits a `console.warn` (non-breaking) — short HMAC secrets can be brute-forced offline from any captured token.

- Updated dependencies [05eb2b4]
  - @celsian/core@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [0c69589]
  - @celsian/core@0.5.1

## 0.3.19

### Patch Changes

- dec80a7: Production hardening release: security fixes (rate-limit IP spoofing, JWT secret scoping, session regeneration, lambda proto validation, error stack guards), app.ts decomposition into body-parser and error-handler modules, file upload plugin, Bun and Deno adapters, ws-redis distributed WebSocket, deploy command with platform auto-detection, integration and stress tests, Fastify migration guide.
- Updated dependencies [dec80a7]
  - @celsian/core@0.4.0

## 0.3.16

### Patch Changes

- Updated dependencies
  - @celsian/core@0.3.16

## 0.3.3

### Patch Changes

- 5d0dc35: Security, reliability, and DX improvements from comprehensive product audit.

  **Security**: Rate limiter uses rightmost XFF IP and throws when disabled. Edge router blocks SSRF to internal IPs, prevents ReDoS, validates route patterns. CORS throws on wildcard+credentials. Redirect validates URLs. Body parsing stream-limits chunked requests.

  **Reliability**: Structured logging for fire-and-forget hooks. SSE auto-close for stale channels. Cron/rate-limit timers unref'd. Task worker stop has deadline. WebSocket upgrade auth callback.

  **DX**: `TypedRouteOptions` for typed `parsedBody` in `app.route()`. Cache key Vary header support.

- Updated dependencies [5d0dc35]
  - @celsian/core@0.3.3
