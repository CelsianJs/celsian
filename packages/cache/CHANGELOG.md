# @celsian/cache

## 0.6.3

## 0.6.2

### Patch Changes

- 4246e07: Preserve stream ownership from request to transport. SSE data now handles CR,
  CRLF and LF safely, and cancelled or pre-aborted subscriptions release hub
  membership and timers. Node response writers respect backpressure, cancel idle
  producers on disconnect, and retain transport cancellation alongside request
  timeouts. The Node adapter shares the core HTTP conversion implementation.

  Response cache keys preserve the order of repeated query parameters while still
  normalizing distinct parameter names. Hashed entries retain their full logical
  key so invalidation works for long paths, including across cache instances.

  **Upgrade note:** clear or rebuild existing persistent response-cache entries
  when deploying this release. Previous entries may have collapsed repeated-query
  ordering or lack the identity metadata needed to invalidate long hashed keys;
  their original identity cannot be reconstructed. Invalidation of hashed entries
  now reads stored metadata, which adds KV reads; ordinary short-key cache hits do
  not add a metadata lookup.

## 0.6.1

## 0.6.0

### Minor Changes

- 1e92ae8: Resolve the request's real authority, and resolve hooks for the matched scope.

  Several separately-reported security bugs turned out to share two root causes.

  **`request.url` carried the address the server BOUND to, not the host the client
  addressed.** `serve()` composes `http://${host}:${port}`, and `host` is the
  wildcard `0.0.0.0` under `NODE_ENV=production`. The URL that applied
  `x-forwarded-proto` and the `trustedHosts`-gated host rewrite was computed and
  then passed to the request builder as a parameter that was never read, so:

  - `trustProxy` and `trustedHosts` were dead code. `x-forwarded-proto` was never
    applied and the host-header-injection allowlist never ran, both contrary to
    their documentation.
  - The CSRF origin check compared `Origin` against the bind address, which
    INVERTED the control: a legitimate same-origin browser POST was rejected 403
    while a request with no `Origin` header passed.
  - The shared response cache keyed every tenant to the same `0.0.0.0` authority,
    so one tenant's response body was served to another.

  `request.url` now reports the host the client addressed, taken from the `Host`
  header, with `x-forwarded-proto` and an allowlisted `x-forwarded-host` applied
  under `trustProxy`. A `Host` value that is not a bare authority (userinfo, a
  path, a query) is ignored in favour of the transport authority. The cache
  additionally keys on `Host` directly, so it is correct independently of this.

  **Hook resolution stopped at the root scope.** A plugin registered WITH a prefix
  lives in a child scope and was invisible to two gates:

  - WebSocket upgrades were not gated by auth hooks from prefixed plugins. The
    identical plugin rejected an unauthenticated HTTP request with 401 and accepted
    the unauthenticated handshake with 101, then delivered its payload.
  - The 405 `Allow` header enumerated the methods of routes sitting behind an
    encapsulated guard, disclosing a route surface the caller was not authorized to
    see.

  Both now resolve hooks for the path actually being served.

- 0042f48: Close four confirmed leaks in the shared response cache and the session store.

  - **Cross-tenant leak.** Scheme and host were in the cache key, but the real
    `Host` header was not, and `request.url` on a server bound to `0.0.0.0`
    carries the BIND address for every tenant. One process serving several
    domains collapsed into a single bucket and served tenant A's body to tenant
    B. `Host` is now partitioned like the other host-rewrite headers, so tenants
    stay separate whatever the adapter puts in `request.url`.
  - **Credential detection now fails closed.** It was a three-entry denylist
    (`authorization`, `cookie`, `proxy-authorization`) that missed `x-api-key`,
    `x-auth-token`, `x-session-id` and every other auth transport, and a
    per-user JSON response carries no `Set-Cookie`/`Vary`/`Cache-Control` to
    catch it downstream, so one user's token was stored and replayed to the
    next. Any request header that is not known-public, keyed, or listed in the
    new `publicHeaders` option now counts as a possible credential, and such a
    request only participates in the cache for a response marked
    `Cache-Control: public` or `s-maxage=N` (RFC 9111 section 3.5).
  - **Binary bodies survive.** Bodies were round-tripped through `.text()`, so
    every image, font, PDF, protobuf and gzip body was permanently replaced with
    U+FFFD, on the first uncached request as well as on the hit. Bodies are now
    stored as bytes; entries written by earlier releases still replay as text.
  - **Session fixation.** `regenerate()` returned a new object, so
    `await session.regenerate()` left the caller holding, and setting a cookie
    for, the attacker's planted id. It now rotates the id IN PLACE and is
    documented in the README and in the `/login` example.

  Also: `Cache-Control: no-cache`/`no-store`/`max-age=0` and `Pragma: no-cache`
  no longer skip the single flight (they turned 100 concurrent requests into 100
  origin executions); over-long keys are hashed instead of bypassing the cache
  entirely; response `Expires`, `Pragma: no-cache`, `max-age` and `s-maxage` are
  honoured for storability and lifetime; `compress()` and the cache now compose
  (`Accept-Encoding` is keyed); `invalidate()` purges query-string variants and
  hosts with a port; `MemoryKVStore.keys(pattern)` matches without backtracking
  (a 17-character pattern used to block the event loop for 11 seconds).

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

- d668e87: Security: gate WebSocket upgrades on plugin hooks, close the file-serving race, harden cache keys

  Findings from an independent adversarial re-audit of the hardening sprint. Each
  one was proven with an executed proof of concept and now has a regression test.

  **WebSocket upgrades skipped every plugin-registered hook** (`@celsian/core`,
  also affects `@celsian/adapter-bun`). After the hook-resolution rewrite, the
  upgrade path read `rootContext.hooks.onRequest`, which holds only hooks added via
  `app.addHook`. Anything contributed by `app.register(plugin)` lives on a child
  context and was invisible there, so `csrf()`, `rateLimit()`, and auth plugins
  registered the documented way did not gate handshakes: an HTTP request got 401
  while the WebSocket handshake got 101. Upgrades now resolve the root scope
  through the encapsulation chain, so un-prefixed plugin hooks apply.

  New public accessors replace the internal reach-throughs that caused this:
  `app.getUpgradeHooks()`, `app.hasStructuredLogger()`, and
  `pluginContext.getRequestDecoration(name, { scope })`.

  **TOCTOU race in `reply.sendFile()` / `reply.download()`** (`@celsian/core`). The
  containment check returned a resolved path string that was then re-opened by
  name, so an attacker able to write inside the served root could swap the leaf for
  a symlink in that window (measured: 170 of 2000 concurrent requests returned
  content from outside the root). Files are now opened once with `O_NOFOLLOW` and
  read from that handle; a symlinked leaf is a 403, a missing file a 404.
  `allowSymlinks: true` is unchanged.

  **Unknown-tag escape hatch in the RPC wire decoder** (`@celsian/rpc`). An
  unrecognised `__t` tag returned the raw `JSON.parse` object, skipping the
  `__proto__`/`constructor`/`prototype` scrub entirely, so any payload could opt
  out of it by inventing a tag. Unknown tags are now rebuilt like plain objects.

  **Cache poisoning through host-rewrite headers outside the denylist**
  (`@celsian/cache`). `forwarded` (the RFC 7239 standard header),
  `x-forwarded-scheme`, `x-forwarded-port`, `x-forwarded-prefix`,
  `x-forwarded-uri`, `x-forwarded-ssl`, `x-http-host-override`, `x-original-host`,
  and `x-original-uri` are now partitioned eagerly alongside the existing six. A
  denylist cannot be complete, and the README now says so explicitly: any request
  header a handler reflects into a response must be listed in `varyHeaders`.

  **Behaviour change:** the default cache key now includes the SCHEME
  (`GET:https//example.com:/data`), so `http://x.app/data` and `https://x.app/data`
  no longer share an entry. This invalidates entries written by earlier versions,
  which is correct for a safety boundary. `invalidate()` still accepts the
  host-less `GET:/data` form.

  **Ambient JWT guard failed open to an arbitrary realm** (`@celsian/jwt`). A route
  outside every realm's scope using a no-argument `createJWTGuard()` authenticated
  against whichever realm registered last, so tenant B's token was accepted on a
  route that belongs to no tenant. With exactly one realm registered the fallback
  is unchanged; with two or more it now throws an actionable error naming
  `jwt(...).guard()` and `createJWTGuard({ secret })`.

  **Behaviour change:** an unbound `createJWTGuard()` on a route outside every
  realm now throws instead of silently picking a realm, on apps with more than one
  realm registered.

  **RPC content-type check was a substring match** (`@celsian/rpc`). `Content-Type:
text/plain; charset=application/json` is CORS-simple but passed as JSON,
  defeating the preflight property the JSON requirement exists to guarantee. The
  MIME essence is now parsed and compared exactly, accepting `application/json` and
  any `+json` suffix (and, newly, mixed-case spellings).

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
