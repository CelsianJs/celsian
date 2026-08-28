---
"@celsian/core": patch
---

Three fixes, two of which change behaviour. Read those two before upgrading.

**A response schema no longer defeats a streaming JSON response.** Validating a
handler-built `Response` called `response.clone().json()`, which tees the body
and drains it to completion. Any route returning `reply.stream()` with a JSON
content type alongside a 2xx `schema.response` was fully buffered before the
client saw a byte, and an endless stream hung until the request timeout fired a
504. Measured on a stream whose first chunk arrives at 600ms, `handle()`
returned at 603ms with a schema and 18ms without; it now returns at 0ms with
one. Validation now reads only a body Celsian serialized itself, so no stream is
ever touched.

Deliberate narrowing: a handler that hand-builds
`new Response(JSON.stringify(x), { 'content-type': 'application/json' })`,
bypassing both `reply.json()` and the auto-serializer, is no longer
response-validated. A buffered `Response` and a streaming one expose an
identical `body`, so there is no way to read the first without risking draining
the second. Every documented way to send JSON is unaffected.

**BEHAVIOUR CHANGE: a prefix-scoped guard now runs before a custom 404
handler.** A genuine 404 resolved `onRequest` from the root scope only, so a
plugin registered with `{ prefix: '/admin' }` never saw a request to
`/admin/nonexistent` while the identical un-prefixed guard did. The 404 path now
takes the same union of covering guards that an unrouted WebSocket upgrade
does. An app with a prefix-scoped guard will now get that guard's response
(commonly 401) where it previously got its custom or default 404.

**BEHAVIOUR CHANGE: cron day fields follow unix semantics, so some jobs fire
more often.** `shouldRun` ANDed all five fields; Vixie cron runs the job when
either day-of-month or day-of-week matches whenever both are restricted.
`0 0 13 * 5` means "the 13th of every month, and every Friday" and previously
fired only when the 13th was a Friday. This only affects expressions where
neither day field begins with `*`. Everything else is unchanged.
