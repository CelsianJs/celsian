---
"celsian": patch
---

Docs: fix every crashing documentation sample and inaccuracy (Track 5).

- ESM-only: README + quickstart manual setup now set `"type": "module"` (top-level await in `@celsian/schema` crashes under CommonJS).
- Rate limiting: every sample now passes `trustProxy: true` (or a `keyGenerator`) — `rateLimit()` throws at registration without one. Scoped rate limits inside a feature plugin now correctly use `{ encapsulate: false }`; the plugins doc's scoped-registration table no longer documents a pattern that silently disables limiting.
- Fastify migration guide: corrected adapter handler names (`createLambdaHandler`, `createVercelHandler`/`createVercelEdgeHandler`), the hook mapping (`preParsing`/`preValidation`/`preSerialization` all exist), `inject()` returning a Web `Response` (`status` + `await json()`), `reply.status(n).json()` (the second `json()` arg is ignored), and `req.parsedBody` for the validated body.
- SECURITY.md: replaced the dead `security@celsianjs.dev` address with GitHub private vulnerability reporting; updated supported versions to 0.5.x.
- README: single reconciled benchmark table, install→build→test contributing steps, workspace-aware demo run instructions, the 8-adapter table, and a WebSocket note (`npm i ws` on Node; Node + Bun only today).
- LICENSE copyright, site version badge, real usage examples for `@celsian/queue-redis` and `@celsian/ws-redis`, a new `docs/errors.md` error reference, a 0.5.1 CHANGELOG entry with 0.3.x/0.4.0 backfill, and moved internal planning/audit artifacts to `docs/internal/`.
