---
"@celsian/core": minor
"@celsian/cache": minor
"@celsian/jwt": minor
"@celsian/rpc": patch
---

Security: gate WebSocket upgrades on plugin hooks, close the file-serving race, harden cache keys

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
