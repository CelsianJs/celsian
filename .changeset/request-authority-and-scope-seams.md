---
"@celsian/core": minor
"@celsian/cache": minor
---

Resolve the request's real authority, and resolve hooks for the matched scope.

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
