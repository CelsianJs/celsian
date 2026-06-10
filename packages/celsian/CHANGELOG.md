# celsian

## 0.5.2

### Patch Changes

- 05eb2b4: Core hardening (0.5.2).

  **Behavior changes — read before upgrading:**

  - **Production now binds `0.0.0.0`.** `serve()` previously always bound `localhost`
    (IPv6 `::1`), making the server unreachable from a Docker/Fly/Railway port map.
    It now binds `0.0.0.0` when `NODE_ENV=production` (still `localhost` in dev),
    after honoring an explicit `host` option or `HOST` env var. If you relied on
    loopback-only binding in production, set `host`/`HOST` to `127.0.0.1` explicitly.
  - **CSRF `excludePaths` now match by path segment.** An entry like `/api` previously
    matched only the exact path `/api`; it now also exempts `/api/...` (but not
    `/apix`). This widens existing exclusions — review your `excludePaths` lists.

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
  - Rate limiting: every sample now passes `trustProxy: true` (or a `keyGenerator`) — `rateLimit()` throws at registration without one. Scoped rate limits inside a feature plugin now correctly use `{ encapsulate: false }`; the plugins doc's scoped-registration table no longer documents a pattern that silently disables limiting.
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
