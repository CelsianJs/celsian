# @celsian/adapter-bun

## 0.6.1

## 0.6.0

### Minor Changes

- 1a066de: Secure WebSocket upgrades, wire Bun WebSockets, remove the unimplemented Node build adapter.

  **@celsian/core, WebSocket upgrades are now gated (security fix).**
  `serve()` accepted every WebSocket handshake that matched an `app.ws()` path: no
  Origin check, and no `onRequest` hook ever ran. Because WebSocket handshakes are
  exempt from the same-origin policy and CORS, any page could open an authenticated
  socket against a cookie-session app (cross-site WebSocket hijacking). Upgrades now
  run an Origin allow-list (same-origin by default), the app's root `onRequest`
  hooks (so auth guards and rate limiters apply), a per-IP connection cap
  (default 64), and a 1 MiB `maxPayload` in place of the `ws` default of 100 MB.
  New `serve()` options: `allowedOrigins`, `allowMissingOrigin`, `skipUpgradeHooks`,
  `maxPayload`, `maxConnectionsPerIP`. New exports: `authorizeWSUpgrade`,
  `checkWSOrigin`, `WSConnectionLimiter`.

  BREAKING: cross-origin and Origin-less handshakes that previously succeeded are
  now rejected with 403. Set `allowedOrigins` for cross-origin browser clients and
  `allowMissingOrigin: true` for non-browser clients.

  **@celsian/core, process safety and logging.** `serve()` installs
  `unhandledRejection`/`uncaughtException` handlers that log with full context,
  drain in-flight requests, and exit non-zero (opt out with
  `handleFatalErrors: false`), and detaches all of its process listeners on close.
  The startup line is no longer printed twice: the plain-text line is emitted only
  when the structured logger is disabled. `ws` is now declared as an optional peer
  dependency, and the missing-`ws` warning names the exact install command.

  **@celsian/adapter-bun, WebSocket support now actually works.**
  `createBunServeOptions()` never set the `websocket` key, so `server.upgrade()`
  could not succeed and the documented Bun WebSocket support was inoperative. The
  adapter now provides a full Bun `websocket` handler (`open`/`message`/`close`/
  `drain`) bridged to the app's WS registry, applies the same upgrade gate as core,
  and returns `undefined` after a successful upgrade as Bun requires.

  BREAKING: `BunFetchHandler` may now return `undefined`; `createBunHandler` takes
  an optional options argument.

  **@celsian/adapter-node, removed the unimplemented build adapter.**
  The default export (`buildEnd()`, `entryTemplate`) targeted a `@celsian/build`
  pipeline that does not exist; `buildEnd()` could only throw. It has been removed
  along with the dead server-entry template, and the README no longer documents it
  or a `@celsian/build` peer dependency. `writeWebResponse()` now writes multiple
  `Set-Cookie` headers as separate lines instead of one comma-joined value.

  BREAKING: the default export is now `serve`; `ThenAdapter`, `buildEnd()`, and
  `entryTemplate` are gone. Use `serve(app, options)`.

  **@celsian/adapter-deno** throws `CelsianError` instead of a bare `Error` when the
  Deno runtime is absent.

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

## 1.0.0

### Minor Changes

- dec80a7: Production hardening release: security fixes (rate-limit IP spoofing, JWT secret scoping, session regeneration, lambda proto validation, error stack guards), app.ts decomposition into body-parser and error-handler modules, file upload plugin, Bun and Deno adapters, ws-redis distributed WebSocket, deploy command with platform auto-detection, integration and stress tests, Fastify migration guide.

### Patch Changes

- Updated dependencies [dec80a7]
  - @celsian/core@0.4.0
