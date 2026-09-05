# celsian

## 0.6.2

### Patch Changes

- Updated dependencies [4246e07]
- Updated dependencies [bc87e6e]
- Updated dependencies [d1e677e]
  - @celsian/core@0.6.2
  - @celsian/schema@0.6.2

## 0.6.1

### Patch Changes

- @celsian/core@0.6.1
- @celsian/schema@0.6.1

## 0.6.0

### Minor Changes

- 1e92ae8: Re-export all of `@celsian/core`, and stop depending on `@celsian/rpc` and `@celsian/cli`.

  The umbrella package carried a hand-maintained export list that had drifted to 33
  of core's 65 exports, so `celsian.upload` and `celsian.createSSEHub` were
  `undefined` despite both being documented in the core README, and every feature
  added to core since that list was last touched was unreachable through `celsian`.
  It now re-exports `@celsian/core` and `@celsian/schema` wholesale, so it cannot
  drift again.

  `@celsian/rpc` and `@celsian/cli` are no longer runtime dependencies. They were
  never re-exported, so they could not be reached through `celsian` anyway: they
  only added download weight, and `@celsian/cli` is a development tool that has no
  business in a runtime dependency tree. Both remain available as their own
  installs, which is what the README already told you to do.

### Patch Changes

- 0042f48: Correct the deploy-adapter usage docs and clean up the published comment surface.

  - **`flyAdapter()` and `railwayAdapter()` documented an API that does not
    exist.** Both JSDoc examples showed
    `defineConfig({ build: { adapter: flyAdapter(...) } })`, but `CelsianConfig`
    has no `build` key and nothing reads one, so following the doc produced a
    config object that was silently ignored and no `fly.toml` / `Procfile` was
    ever written. Both now document the path that works: call `buildEnd()` from a
    post-build script, with its real argument shape.
  - Em-dashes are removed from every published source comment and generated file
    header across these packages, so the text in the shipped `.d.ts` files and in
    generated `fly.toml` / `Dockerfile` output is plain ASCII.

  No runtime behaviour changes in any of these packages. They are versioned only
  to keep the release line in lockstep and to give each one an accurate changelog
  entry for what actually changed.

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
- Updated dependencies [0d3097c]
- Updated dependencies [e75e588]
- Updated dependencies [7e85b5a]
- Updated dependencies [d668e87]
  - @celsian/core@0.6.0
  - @celsian/schema@0.6.0

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
  - @celsian/cli@0.5.5
  - @celsian/schema@0.5.5
  - @celsian/rpc@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies [74898eb]
  - @celsian/schema@0.5.4
  - @celsian/cli@0.5.4
  - @celsian/core@0.5.4
  - @celsian/rpc@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies [a60b3e4]
  - @celsian/core@0.5.3
  - @celsian/cli@0.5.3
  - @celsian/schema@0.5.3
  - @celsian/rpc@0.5.3

## 0.5.2

### Patch Changes

- 05eb2b4: Core hardening (0.5.2).

  **Behavior changes -- read before upgrading:**

  - **Production now binds `0.0.0.0`.** `serve()` previously always bound `localhost`
    (IPv6 `::1`), making the server unreachable from a Docker/Fly/Railway port map.
    It now binds `0.0.0.0` when `NODE_ENV=production` (still `localhost` in dev),
    after honoring an explicit `host` option or `HOST` env var. If you relied on
    loopback-only binding in production, set `host`/`HOST` to `127.0.0.1` explicitly.
  - **CSRF `excludePaths` now match by path segment.** An entry like `/api` previously
    matched only the exact path `/api`; it now also exempts `/api/...` (but not
    `/apix`). This widens existing exclusions -- review your `excludePaths` lists.

  **Also fixed:** options-object route handlers (`app.post(url, { schema, handler })`),
  serverless-safety warnings now surface through the default (noop) logger, CORS
  `Vary: Origin` on reflected origins, `bodyLimit` enforced for custom content-type
  parsers, WS dependency/runtime warnings (Node `ws` install hint; Bun points at
  `@celsian/adapter-bun`), `serve()` resolves only after listening and reports the
  OS-assigned port, binary `reply.send()` emits `application/octet-stream`, cron
  double-fire guard, explicit server request/headers timeouts, and umbrella
  re-exports (csrf, etag, db analytics).

- 05eb2b4: Docs: fix every crashing documentation sample and inaccuracy (Track 5).

  - ESM-only: README + quickstart manual setup now set `"type": "module"` (top-level await in `@celsian/schema` crashes under CommonJS).
  - Rate limiting: every sample now passes `trustProxy: true` (or a `keyGenerator`) -- `rateLimit()` throws at registration without one. Scoped rate limits inside a feature plugin now correctly use `{ encapsulate: false }`; the plugins doc's scoped-registration table no longer documents a pattern that silently disables limiting.
  - Fastify migration guide: corrected adapter handler names (`createLambdaHandler`, `createVercelHandler`/`createVercelEdgeHandler`), the hook mapping (`preParsing`/`preValidation`/`preSerialization` all exist), `inject()` returning a Web `Response` (`status` + `await json()`), `reply.status(n).json()` (the second `json()` arg is ignored), and `req.parsedBody` for the validated body.
  - SECURITY.md: replaced the dead `security@celsianjs.dev` address with GitHub private vulnerability reporting; updated supported versions to 0.5.x.
  - README: single reconciled benchmark table, install→build→test contributing steps, workspace-aware demo run instructions, the 8-adapter table, and a WebSocket note (`npm i ws` on Node; Node + Bun only today).
  - LICENSE copyright, site version badge, real usage examples for `@celsian/queue-redis` and `@celsian/ws-redis`, a new `docs/errors.md` error reference, a 0.5.1 CHANGELOG entry with 0.3.x/0.4.0 backfill, and moved internal planning/audit artifacts to `docs/internal/`.

- Updated dependencies [05eb2b4]
- Updated dependencies [05eb2b4]
- Updated dependencies [05eb2b4]
  - @celsian/cli@0.5.2
  - @celsian/core@0.5.2
  - @celsian/rpc@0.5.2
  - @celsian/schema@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [0c69589]
  - @celsian/core@0.5.1
  - @celsian/cli@0.5.1
  - @celsian/schema@0.5.1
  - @celsian/rpc@0.5.1

## 0.4.0

### Patch Changes

- Updated dependencies [dec80a7]
  - @celsian/core@0.4.0
  - @celsian/cli@0.4.0

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
