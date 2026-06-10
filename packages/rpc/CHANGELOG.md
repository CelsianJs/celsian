# @celsian/rpc

## 0.5.2

### Patch Changes

- 05eb2b4: Security hardening across rate-limit, rpc, and jwt:

  - **@celsian/rate-limit (SECURITY, behavior change):** with `trustProxy: true`, the default key is now taken from X-Forwarded-For counting `trustedProxyHops` (new option, default `1`) from the RIGHT instead of using the leftmost entry. The leftmost XFF value is client-supplied — rotating it per request fully bypassed rate limiting and flooded the store with unique keys. With one trusted proxy the keyed IP is the last entry (what your proxy appended); set `trustedProxyHops` to your actual proxy depth, or keep using a custom `keyGenerator`. Note: deployments behind multiple proxies that relied on the old leftmost behavior will now key a different IP — this is intentional.
  - **@celsian/rate-limit (SECURITY):** `MemoryRateLimitStore` now enforces a max-keys cap (`maxKeys` option, default `100_000`, also exposed on `rateLimit()` options) with expired-first/oldest-first eviction so spoofed-key floods can no longer exhaust memory.
  - **@celsian/rate-limit (fail-closed):** `rateLimit()` now throws a `CelsianError` at registration when `window` or `max` is missing/NaN/non-positive. Previously an invalid `window` (e.g. passing `windowMs`) made every bucket's `resetAt` NaN and silently disabled rate limiting (fail open).
  - **@celsian/rpc (SECURITY):** unexpected (5xx-equivalent) procedure errors no longer leak raw `error.message`/`error.code` to clients when `NODE_ENV`/`CELSIAN_ENV` is `production` — they return a generic `INTERNAL_ERROR` body (mirroring `@celsian/core`'s error-handler sanitization) and are always logged server-side. Full detail is preserved in development, and intentional HTTP-style errors (`statusCode < 500`) pass through unchanged.
  - **@celsian/rpc:** new `rpc.mount(app, prefix?)` helper registers both `GET` and `POST` wildcard routes on a Celsian app (the client uses GET for queries and POST for mutations). The README previously documented `app.all(...)`, which `CelsianApp` does not have; `mount()` is now the documented primary path.
  - **@celsian/jwt:** registering with an HS\* secret shorter than 32 bytes now emits a `console.warn` (non-breaking) — short HMAC secrets can be brute-forced offline from any captured token.
  - @celsian/schema@0.5.2

## 0.5.1

### Patch Changes

- @celsian/schema@0.5.1
