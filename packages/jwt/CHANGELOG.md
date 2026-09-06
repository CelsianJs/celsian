# @celsian/jwt

## 0.6.3

### Patch Changes

- Updated dependencies
  - @celsian/core@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies [4246e07]
- Updated dependencies [bc87e6e]
- Updated dependencies [d1e677e]
  - @celsian/core@0.6.2

## 0.6.1

### Patch Changes

- @celsian/core@0.6.1

## 0.6.0

### Minor Changes

- 1e92ae8: Close two cross-tenant authentication bypasses, and fail closed when a realm is ambiguous.

  Both bypasses were reachable through the shape the plugin's own JSDoc documents,
  and both are fixed.

  - **A second realm could authenticate on the first realm's routes.** The realm
    census was documented as failing closed "the moment the answer becomes a
    guess", but it was only consulted when no scoped config was found. A realm
    registered WITHOUT a prefix creates a transparent context whose decorations
    propagate into the parent scope, so a scoped config was always present and the
    census never ran. Last registration won. Reproduced: tenant B's token returned
    200 on tenant A's route as its own subject, while tenant A's own token returned
    401 on that same route.
  - **`app.jwt` bound app-wide to whichever realm registered first.** Core hoists
    decorations first-writer-wins, so a second tenant's login route calling the
    documented `app.jwt.sign()` minted a credential signed with the FIRST tenant's
    secret: valid on tenant A's protected routes, rejected by tenant B's own.
    `app.jwt` now throws once a second realm registers, naming `realm.sign()` /
    `realm.verify()` as the realm-bound alternative.

  Internally, each realm now carries its own presence key rather than sharing one
  symbol, so two realms covering the same route are both visible instead of one
  silently overwriting the other.

  **Behavior change.** Two realms registered WITHOUT prefixes on one app now refuse
  to authenticate rather than appearing to isolate. That shape only ever produced
  the right answer through a last-writer tie-break in scope resolution, which is
  the same mechanism behind the bypass above, so it was never isolation. Give each
  realm a prefix (`app.register(realm, { prefix: '/tenant-a' })`), or bind the
  guard explicitly with `realm.guard()` or `createJWTGuard({ secret })`.

  Single-realm apps are unaffected, and realms registered under distinct prefixes
  keep working and isolating, both verified.

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

- d574a13: Prevent cross-user response disclosure by bypassing the shared response cache
  for credentialed requests, partitioning reflected CORS responses by Origin,
  refusing `no-cache`, zero-age, and private responses, and storing only `Vary`
  responses whose request fields are represented in the cache key. Remove the module-global
  JWT guard fallback so no-argument guards resolve secrets and algorithms only
  from the current app's request.
- Updated dependencies [d574a13]
  - @celsian/core@0.5.5

## 0.5.4

### Patch Changes

- @celsian/core@0.5.4

## 0.5.3

### Patch Changes

- a60b3e4: Production-readiness DX fixes and dependency maintenance (0.5.3).

  - **@celsian/core (fail-loud config):** `loadConfig()` no longer swallows a broken `celsian.config.*` with a bare `catch`. A genuinely absent config still falls back to defaults, but a config that exists and fails to load (syntax/runtime error, or a missing import it depends on) now throws the new exported `ConfigLoadError` naming the file and cause. `serve()` surfaces it instead of silently binding defaults -- fixing the "why won't my config apply" black hole where a typo in the config left the server on port 3000 with no diagnostic.
  - **@celsian/cli (`celsian dev`):** checks the entry file exists before spawning `tsx`, printing `Entry file not found: <entry>` plus usage (mirroring `celsian routes`) instead of a raw "Cannot find module" stack trace on first run.
  - **@celsian/cli (`celsian generate rpc`):** now scaffolds a mountable, type-correct starting point -- wrapped in `router()`, exported as a registerable `PluginFunction` that calls `new RPCHandler(...).mount(app)`, with `.input(schema)` guidance -- instead of a bare object that had no path to a live endpoint and destructured an always-`undefined` `input`.
  - **@celsian/jwt:** bump `jose` `5.10.0` → `6.2.2` (major). No API changes; sign/verify/expiry/algorithm selection and cross-app guard isolation are all covered by the existing jwt test suite under jose 6.
  - **@celsian/ws-redis, @celsian/queue-redis:** bump `ioredis` `5.9.3` → `5.11.1` (minor).

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
