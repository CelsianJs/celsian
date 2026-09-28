---
"@celsian/core": patch
"@celsian/rate-limit": patch
"@celsian/adapter-bun": patch
"@celsian/adapter-deno": patch
"@celsian/adapter-cloudflare": patch
"@celsian/adapter-lambda": patch
---

`csrf({ trustedOrigins })` now admits the origins it lists. A browser labels a
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
