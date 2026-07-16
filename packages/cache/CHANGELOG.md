# @celsian/cache

## 0.5.5

### Patch Changes

- d574a13: Prevent cross-user response disclosure by bypassing the shared response cache
  for credentialed requests, partitioning reflected CORS responses by Origin,
  refusing `no-cache`, zero-age, and private responses, and storing only `Vary`
  responses whose request fields are represented in the cache key. Remove the module-global
  JWT guard fallback so no-argument guards resolve secrets and algorithms only
  from the current app's request.

## 0.5.4

## 0.5.3

## 0.5.2

## 0.5.1

## 0.3.19

### Patch Changes

- dec80a7: Production hardening release: security fixes (rate-limit IP spoofing, JWT secret scoping, session regeneration, lambda proto validation, error stack guards), app.ts decomposition into body-parser and error-handler modules, file upload plugin, Bun and Deno adapters, ws-redis distributed WebSocket, deploy command with platform auto-detection, integration and stress tests, Fastify migration guide.

## 0.3.1

### Patch Changes

- 5d0dc35: Security, reliability, and DX improvements from comprehensive product audit.

  **Security**: Rate limiter uses rightmost XFF IP and throws when disabled. Edge router blocks SSRF to internal IPs, prevents ReDoS, validates route patterns. CORS throws on wildcard+credentials. Redirect validates URLs. Body parsing stream-limits chunked requests.

  **Reliability**: Structured logging for fire-and-forget hooks. SSE auto-close for stale channels. Cron/rate-limit timers unref'd. Task worker stop has deadline. WebSocket upgrade auth callback.

  **DX**: `TypedRouteOptions` for typed `parsedBody` in `app.route()`. Cache key Vary header support.
