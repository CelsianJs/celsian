# @celsian/adapter-lambda

## 0.6.6

### Patch Changes

- Updated dependencies [e79f5ff]
  - @celsian/core@0.6.6

## 0.6.5

### Patch Changes

- 879fd05: `csrf({ trustedOrigins })` now admits the origins it lists. A browser labels a
  request from a separate front-end origin `Sec-Fetch-Site: same-site` or
  `cross-site`, and the plugin rejected every such label before it looked at
  `trustedOrigins`, so the option could never let a real browser request through.
  A same-site or cross-site request is now accepted when its `Origin` is listed,
  and it still needs a valid token. One that names no Origin, an opaque one, or an
  unlisted one is still refused.

  Handlers can read the client's address as `request.ip`. It is the peer that
  opened the connection: the Node socket, Bun's `server.requestIP()`, Deno's
  `remoteAddr`, Cloudflare's `CF-Connecting-IP`, or API Gateway's source IP.
  Request headers are not consulted unless you name one with the new `clientIp`
  app option, e.g. `createApp({ clientIp: { header: 'fly-client-ip' } })` or
  `{ header: 'x-forwarded-for', hops: 2 }`. `app.fetch` reads the peer address
  from Bun's and Deno's second argument, and `app.inject()` takes a
  `remoteAddress`. Hooks run on a WebSocket handshake see the same value.
  `@celsian/rate-limit` keys a request that carries no usable
  forwarding header on `request.ip` instead of the one shared "anonymous" bucket.

  `onSend` and `onResponse` now see the status that is actually sent.
  `reply.statusCode` used to stay 200 when a handler returned its own `Response`,
  threw, missed a route (404/405) or was answered early by a hook. `onResponse`
  also runs for thrown errors, timeouts, 404/405 misses and early returns, once
  per request. An early return still skips `onSend`.

  Cookies set with `reply.cookie()` now reach the client when the handler returns
  a plain object, a string or nothing. On Node, a cookie set with
  `reply.header("set-cookie", ...)` (as the CSRF plugin does) is no longer
  dropped when the same response also carries `reply.cookie()` cookies.

  Headers set with `reply.header()` are kept when the handler returns its own
  `Response`. When the reply and that `Response` set the same header, the
  `Response` keeps its value, so an `onSend` default such as
  `cache-control: no-store` no longer overwrites a route's own header. An `onSend`
  hook can still replace a value it was shown in `reply.headers`. `Vary` values
  from both sides are combined and `Set-Cookie` values are appended. 404 and 405
  responses follow the same rule, so their JSON `content-type` is no longer
  replaced by a reply header.

  **Behaviour changes to check when upgrading:** headers and cookies set on the
  reply before a handler throws now reach the error response even without
  `onSend` hooks; `onResponse` hooks now also run for errors, misses and early
  returns, so metrics and access logs built on them will count requests they
  previously missed.

- Updated dependencies [879fd05]
  - @celsian/core@0.6.5

## 0.6.4

### Patch Changes

- Updated dependencies [48fb11d]
  - @celsian/core@0.6.4

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

- 05eb2b4: Serverless adapter fidelity and edge-compatibility fixes:

  - **adapter-lambda**: forward API Gateway v2 `event.cookies` as the `cookie` request header (handlers previously saw no cookies); pass base64-encoded bodies through as raw bytes instead of corrupting binary payloads via utf-8 decoding; support API Gateway v1 (REST API) and ALB events with shape detection, multiValueHeaders/multiValueQueryStringParameters merging, and v1/ALB response formats (including `multiValueHeaders` set-cookie handling).
  - **adapter-vercel**: remove the module-level `node:crypto` import that broke edge bundling (`esbuild --platform=neutral`); the cron handler's timing-safe secret comparison now uses Web Crypto (`crypto.subtle`), keeping `createVercelEdgeHandler` bundleable for edge runtimes.
  - **adapter-cloudflare**: `createCloudflareHandler(app)` now also returns a `scheduled` handler that bridges Cloudflare Cron Triggers to `app.cron()` jobs (matching by cron expression, falling back to all jobs when a single trigger drives them); existing `fetch`-only usage keeps working.
  - **adapter-bun**: document that `server.upgrade()` runs before route hooks (JWT guards/rate limiting do not apply to WS upgrades) and show the `open`-handler auth pattern.
  - **adapter-node**: fix stale `then.config.ts` reference in the README (now `celsian.config.ts`).

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

## 0.3.1

### Patch Changes

- Updated dependencies [5d0dc35]
  - @celsian/core@0.3.3
