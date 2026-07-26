---
"@celsian/core": minor
---

Resolve hooks and decorations through the encapsulation context chain

Route hook chains were snapshotted at `addRoute()` time and read from the root
context at request time, so plugin `onRequest`/`preHandler` hooks never ran,
hooks added after a route was registered were ignored, plugin-scoped
`decorateRequest` was a no-op, and `onSend`/`onResponse` were hoisted onto every
ancestor and fired outside their prefix.

Hook chains and request/reply decorations are now resolved lazily from the
route's context chain and memoized, so registration order no longer matters:

- `app.register(csrf())` (or any plugin registered without a prefix) now guards
  routes declared on the app, for every hook type. Un-prefixed plugins are
  app-wide middleware; a plugin registered **with** a prefix keeps its hooks
  inside that prefix and no longer leaks onto sibling routes.
- `preParsing`, `preValidation` and `onError` registered inside a plugin now run
  (previously only root-context ones did).
- `schema.response` is now enforced: a mismatch returns a generic 500 and logs
  the detail server-side. Opt out with `createApp({ validateResponses: false })`.
- Validated `querystring`/`params` output now reaches `request.query` and
  `request.params` (`parsedQuery` remains an alias), so handlers no longer read
  the raw, uncoerced input.
- Route handlers may return serializable data, not just `Response`, and
  `schema.body`/`schema.querystring` now actually type `parsedBody`/`parsedQuery`
  on `app.get/post/put/patch/delete` and `app.route`.
- Synchronous throws in fire-and-forget (`onResponse`) hooks are logged instead
  of silently swallowed.
