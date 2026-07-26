---
"@celsian/rate-limit": minor
"@celsian/compress": minor
"@celsian/cache": minor
"@celsian/jwt": minor
---

Security hardening across auth, caching, rate limiting, and compression.

**@celsian/jwt**

- The plugin config now binds to the encapsulation context that registered it instead of being hoisted to the root context, where the last-registered realm silently won for the whole process. `jwt()` additionally returns a realm-bound `.guard()` for apps running more than one realm.
- Added `issuer`, `audience`, `subject`, `clockTolerance`, and `maxTokenAge` verification, threaded through every verify path. `sign()` sets `iss`/`aud` from the same config.
- `sign()` now applies a 15 minute default expiry and verification rejects a token with no `exp` (`requireExpiration`, default `true`). BREAKING: previously `sign({ sub })` minted a permanent credential.
- Added asymmetric key support (`publicKey`/`privateKey`, PEM or JWK) and remote JWKS (`jwksUri`, https-only, cached, `kid`-aware, timeout-bounded).

**@celsian/cache**

- BREAKING: the default cache key now includes the request Host and a normalized query string, so one process serving several domains no longer replays one tenant's body to another. Existing entries are invalidated.
- Host-rewriting headers (`X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Server`, `X-Host`, `X-Original-URL`, `X-Rewrite-URL`) are now partitioned eagerly, closing the canonical web-cache-poisoning vector.
- Added single-flight stampede protection, a `queryParams` allow-list, and `maxKeyLength`.
- BREAKING: sessions are no longer persisted until they hold data, so anonymous traffic cannot evict logged-in sessions. Session cookies are now percent-decoded on read, so a custom `generateId` round-trips.
- `MemoryKVStore.incr`/`decr` are now atomic.

**@celsian/rate-limit**

- Added `trustedProxies` (IP/CIDR list): the client IP is the rightmost `X-Forwarded-For` entry that is not one of your proxies.
- BREAKING: `X-Real-IP` is no longer a silent fallback; it requires `trustXRealIp: true`. It previously let a client both bypass its own limit and burn a victim's bucket.
- Eviction now discards the least-established entry rather than the oldest-inserted one, so a flood no longer resets the counters of the clients being throttled. The store warns once when the key cap is hit.
- Keys longer than `maxKeyLength` (256) collapse into one shared bucket, and `Retry-After` is clamped to at least 1.
- Added `createRedisRateLimitStore` for multi-instance deployments (injected client, no new dependency).
- The README now says fixed-window, which is what the implementation is.

**@celsian/compress**

- Compressed responses no longer drop `Set-Cookie`. A compressed `clearCookie()` logout previously never logged anyone out for any gzip-capable client.
- `Vary: Accept-Encoding` is now set on every response the plugin handles, not only compressed ones.
- `Accept-Encoding` is parsed as `(coding, q)` pairs, so `gzip;q=0` is honored as a refusal.
- Added a `filter` option defaulting to a textual content-type allow-list (BREACH exposure), stopped overwriting an explicit `Content-Type`, measured the threshold in bytes rather than UTF-16 code units, and stopped leaking unhandled rejections from the compression stream.
