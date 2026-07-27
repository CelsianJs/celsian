---
"@celsian/cache": minor
---

Close four confirmed leaks in the shared response cache and the session store.

- **Cross-tenant leak.** Scheme and host were in the cache key, but the real
  `Host` header was not, and `request.url` on a server bound to `0.0.0.0`
  carries the BIND address for every tenant. One process serving several
  domains collapsed into a single bucket and served tenant A's body to tenant
  B. `Host` is now partitioned like the other host-rewrite headers, so tenants
  stay separate whatever the adapter puts in `request.url`.
- **Credential detection now fails closed.** It was a three-entry denylist
  (`authorization`, `cookie`, `proxy-authorization`) that missed `x-api-key`,
  `x-auth-token`, `x-session-id` and every other auth transport, and a
  per-user JSON response carries no `Set-Cookie`/`Vary`/`Cache-Control` to
  catch it downstream, so one user's token was stored and replayed to the
  next. Any request header that is not known-public, keyed, or listed in the
  new `publicHeaders` option now counts as a possible credential, and such a
  request only participates in the cache for a response marked
  `Cache-Control: public` or `s-maxage=N` (RFC 9111 section 3.5).
- **Binary bodies survive.** Bodies were round-tripped through `.text()`, so
  every image, font, PDF, protobuf and gzip body was permanently replaced with
  U+FFFD, on the first uncached request as well as on the hit. Bodies are now
  stored as bytes; entries written by earlier releases still replay as text.
- **Session fixation.** `regenerate()` returned a new object, so
  `await session.regenerate()` left the caller holding, and setting a cookie
  for, the attacker's planted id. It now rotates the id IN PLACE and is
  documented in the README and in the `/login` example.

Also: `Cache-Control: no-cache`/`no-store`/`max-age=0` and `Pragma: no-cache`
no longer skip the single flight (they turned 100 concurrent requests into 100
origin executions); over-long keys are hashed instead of bypassing the cache
entirely; response `Expires`, `Pragma: no-cache`, `max-age` and `s-maxage` are
honoured for storability and lifetime; `compress()` and the cache now compose
(`Accept-Encoding` is keyed); `invalidate()` purges query-string variants and
hosts with a port; `MemoryKVStore.keys(pattern)` matches without backtracking
(a 17-character pattern used to block the event loop for 11 seconds).
