# celsian

## 0.3.18

### Patch Changes

- Republish the all-in-one package with resolved dependencies after `0.3.17` was deprecated for unresolved `workspace:*` metadata.
- Updated dependencies
  - @celsian/cli@0.3.18

## 0.3.17

### Patch Changes

- Updated dependencies [e2133f8]
  - @celsian/cli@0.3.17

## 0.3.16

### Patch Changes

- Updated dependencies
  - @celsian/core@0.3.16
  - @celsian/cli@0.3.16

## 0.3.3

### Patch Changes

- 5d0dc35: Security, reliability, and DX improvements from comprehensive product audit.

  **Security**: Rate limiter uses rightmost XFF IP and throws when disabled. Edge router blocks SSRF to internal IPs, prevents ReDoS, validates route patterns. CORS throws on wildcard+credentials. Redirect validates URLs. Body parsing stream-limits chunked requests.

  **Reliability**: Structured logging for fire-and-forget hooks. SSE auto-close for stale channels. Cron/rate-limit timers unref'd. Task worker stop has deadline. WebSocket upgrade auth callback.

  **DX**: `TypedRouteOptions` for typed `parsedBody` in `app.route()`. Cache key Vary header support.

- Updated dependencies [5d0dc35]
  - @celsian/core@0.3.3
  - @celsian/cli@0.3.3
