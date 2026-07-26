---
"@celsian/core": minor
"@celsian/adapter-bun": minor
"@celsian/adapter-node": minor
"@celsian/adapter-deno": patch
---

Secure WebSocket upgrades, wire Bun WebSockets, remove the unimplemented Node build adapter.

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
