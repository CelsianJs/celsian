---
"@celsian/core": patch
"celsian": patch
---

Core hardening (0.5.2).

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
