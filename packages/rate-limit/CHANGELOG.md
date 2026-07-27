# @celsian/rate-limit

## 0.6.0

### Minor Changes

- 1e92ae8: Close an open redirect, a static-file symlink escape, an upload path escape, and two rate-limit key bypasses.

  - **Open redirect via TAB, LF and CR.** `safeRedirectLocation` normalized `\` to
    `/` and rejected `//`, but a URL parser also DELETES ASCII tab, newline and
    carriage return before parsing. `/<TAB>/evil.com` passed validation and was
    emitted as a `Location`, and the browser resolved it to `https://evil.com/`.
    Those characters are now stripped before validation, to a fixed point.
  - **`serve({ staticDir })` followed symlinks out of its root.** An earlier change
    hardened `reply.sendFile()` with `O_NOFOLLOW` and left the static path on a
    lexical check only, so the same process refused a symlinked file through
    `sendFile` (403) and served it through `staticDir` (200). Both paths now share
    one confinement helper, so they cannot drift apart again. Note a symlink INSIDE
    the served root is now also refused.
  - **Upload filenames could escape the upload directory.** `sanitizeFileName`
    stripped leading dots BEFORE trimming whitespace, so a leading space shielded
    the dots and the trim then re-exposed them: `" .."` came back as `".."`, which
    joined onto the upload directory escapes it. Trimming and dot-stripping now run
    as a loop to a fixed point, and `.`, `..`, empty results, Windows reserved
    device names and trailing dots are all rejected.
  - **`reply.redirect()` returned 500 on control characters**, against a docblock
    promising a 400; **`reply.download()` reported 404 for files that exist** when
    the filename was not Latin-1, and did not basename the filename or emit an RFC
    6266 `filename*`.
  - **The cookie `Secure` warn-once set was unbounded** and keyed on the
    client-controlled `Host` header, so spoofed hosts grew it without limit.
  - **The rate limiter handed its bucket key to the client.** When the forwarded
    chain was shorter than the configured hop count, the clamp selected the
    leftmost, fully client-supplied entry. That gave unlimited quota by rotating
    one header, and let an attacker exhaust a DIFFERENT user's bucket. It now fails
    closed. Separately, the key was raw header text, so `1.2.3.4`, `01.02.03.04`,
    `::ffff:1.2.3.4` and `1.2.3.4:<port>` each got their own bucket; keys are now
    canonicalized, and over-long custom keys are hashed rather than sharing one
    bucket.

- 7132039: Security hardening across auth, caching, rate limiting, and compression.

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

### Patch Changes

- 0042f48: Stop shipping broken source maps, and fix the `@celsian/cli` package shape.

  **Source maps are no longer published.** Every package ships `files: ["dist"]`
  and deliberately does not ship `src`, but the build emitted `.js.map` and
  `.d.ts.map` files whose `sources` is `["../src/index.ts"]`, a path that is never
  in the tarball. Consumers got a debugger that could not step into anything and a
  "Go to Definition" that landed on a missing file, while the maps carried real
  weight: `@celsian/core`'s tarball drops from 172.5 kB to 113.0 kB (-34.5%) with
  them removed, 30.1 kB of which was `app.js.map` alone. Without a map, tooling
  falls back to the emitted `.js` / `.d.ts`, which is correct rather than broken.
  Shipping `src` instead would have made the maps work at the cost of roughly
  doubling every tarball for a debugging affordance the project has never offered.

  **`@celsian/cli` is declared as the bin-only package it is.** Its `main` and
  `types` pointed at `dist/index.js`, which is the shebang'd CLI entry, so
  `await import("@celsian/cli")` **executed the CLI** and printed the help banner
  as a side effect of importing it. It also declared `"sideEffects": false`, which
  was untrue of that same entry. `main`, `types` and `sideEffects` are removed and
  no `exports` map is added: the package is consumed through its `celsian` binary,
  and importing it now fails cleanly instead of running a program.

  **`celsian` and `create-celsian` declare `publishConfig.access: "public"`**, the
  only two publishable packages that were missing it.

  **`@celsian/adapter-bun` and `@celsian/adapter-deno` widen their `@celsian/core`
  peer range** from the exact current version to `>=0.5.0 <1.0.0`. An exact peer
  pin meant every consumer had to match the adapter's core version to the patch,
  and it also forced the release tooling to treat every minor as a breaking change
  for those two packages. See `.changeset/README.md`.

- Updated dependencies [408f4af]
- Updated dependencies [a1ef683]
- Updated dependencies [509e696]
- Updated dependencies [509e696]
- Updated dependencies [1a066de]
- Updated dependencies [0042f48]
- Updated dependencies [0042f48]
- Updated dependencies [1e92ae8]
- Updated dependencies [1e92ae8]
- Updated dependencies [e75e588]
- Updated dependencies [7e85b5a]
- Updated dependencies [d668e87]
  - @celsian/core@0.6.0

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

  - **@celsian/rate-limit (SECURITY, behavior change):** with `trustProxy: true`, the default key is now taken from X-Forwarded-For counting `trustedProxyHops` (new option, default `1`) from the RIGHT instead of using the leftmost entry. The leftmost XFF value is client-supplied -- rotating it per request fully bypassed rate limiting and flooded the store with unique keys. With one trusted proxy the keyed IP is the last entry (what your proxy appended); set `trustedProxyHops` to your actual proxy depth, or keep using a custom `keyGenerator`. Note: deployments behind multiple proxies that relied on the old leftmost behavior will now key a different IP -- this is intentional.
  - **@celsian/rate-limit (SECURITY):** `MemoryRateLimitStore` now enforces a max-keys cap (`maxKeys` option, default `100_000`, also exposed on `rateLimit()` options) with expired-first/oldest-first eviction so spoofed-key floods can no longer exhaust memory.
  - **@celsian/rate-limit (fail-closed):** `rateLimit()` now throws a `CelsianError` at registration when `window` or `max` is missing/NaN/non-positive. Previously an invalid `window` (e.g. passing `windowMs`) made every bucket's `resetAt` NaN and silently disabled rate limiting (fail open).
  - **@celsian/rpc (SECURITY):** unexpected (5xx-equivalent) procedure errors no longer leak raw `error.message`/`error.code` to clients when `NODE_ENV`/`CELSIAN_ENV` is `production` -- they return a generic `INTERNAL_ERROR` body (mirroring `@celsian/core`'s error-handler sanitization) and are always logged server-side. Full detail is preserved in development, and intentional HTTP-style errors (`statusCode < 500`) pass through unchanged.
  - **@celsian/rpc:** new `rpc.mount(app, prefix?)` helper registers both `GET` and `POST` wildcard routes on a Celsian app (the client uses GET for queries and POST for mutations). The README previously documented `app.all(...)`, which `CelsianApp` does not have; `mount()` is now the documented primary path.
  - **@celsian/jwt:** registering with an HS\* secret shorter than 32 bytes now emits a `console.warn` (non-breaking) -- short HMAC secrets can be brute-forced offline from any captured token.

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
