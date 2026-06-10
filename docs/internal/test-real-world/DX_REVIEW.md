# CelsianJS DX Review — Real-World Test Evaluation

**Evaluation date:** 2026-03-08
**Tested version:** @celsian/core 0.1.0
**Test suite:** 6 test apps, 62 tests, all passing
**Comparison baseline:** Express 4.x, Fastify 5.x

---

## Overall Ratings

| Category | Rating | Notes |
|---|---|---|
| Ergonomics | 7/10 | Familiar API, some sharp edges |
| Documentation needs | 4/10 | Critical gaps that would block adoption |
| Feature completeness | 8/10 | Impressive for 0.1 — hooks, plugins, CORS, security, DB, WS, tasks, cron |
| Production-readiness | 6/10 | Has the building blocks, a few remaining rough edges |

---

## What Works Well

### Familiar API shape
The `app.get('/path', (req, reply) => ...)` pattern is immediately comfortable for anyone coming from Fastify. The `reply` chaining (`reply.status(201).json(data)`) is intuitive and well-designed.

### Reply helpers are great
`reply.notFound()`, `reply.badRequest()`, `reply.unauthorized()` etc. eliminate boilerplate. These return properly structured JSON error responses with status codes and error codes. This is better than both Express (manual `res.status(404).json(...)`) and Fastify (throwing `httpErrors`).

### inject() for testing is excellent
The `app.inject({ url, method, payload, headers })` pattern means zero HTTP overhead in tests. No port binding, no race conditions. This is Fastify's best feature and Celsian nails it.

### Plugin encapsulation model
The `app.register(plugin, { encapsulate: false })` vs default encapsulation works as expected. Auth hooks scoped to a plugin prefix don't leak to public routes. This was verified in the auth-api tests.

### Built-in security plugin
The Helmet-style `security()` plugin sets 9 security headers out of the box. One-liner setup: `app.register(security(), { encapsulate: false })`. This is better than Express (need helmet), on par with Fastify (need @fastify/helmet).

### Database analytics layer
`trackedPool()` wrapping is a clever pattern. Per-request metric reset, automatic Server-Timing headers, and slow query logging with zero handler changes. The `dbAnalytics()` plugin makes this declarative.

### WebSocket as first-class
`app.ws('/path', { open, message, close })` with built-in broadcast and connection management. Better than Express (need ws + express-ws), comparable to Bun's approach.

---

## Bugs Found

### FIXED: `onSend` hooks previously only fired the first one registered

**Status:** Fixed. The framework now uses `runOnSendHooks` which does not bail on `reply.sent`, allowing multiple onSend hooks to compose correctly. Verified by tests that CORS + custom onSend hooks all fire.

### MEDIUM: `reply.status(204).send(null)` throws

**Severity:** Medium — every DELETE endpoint that follows REST conventions will hit this.

**Root cause:** `reply.send(null)` calls `JSON.stringify(null)` producing `"null"`, then passes it as a body to `new Response("null", { status: 204 })`. The spec forbids bodies on 204 responses, so the Response constructor throws.

**Workaround:** Return `new Response(null, { status: 204 })` directly instead of using reply helpers.

**Fix:** `send(null)` with status 204/304 should produce a bodyless response.

### LOW: CORS `OPTIONS /*path` catch-all turns 404s into 405s

**Severity:** Low — affects only apps using the CORS plugin.

**Root cause:** The CORS plugin registers `OPTIONS /*path` as a route. The router's `hasPath()` matches this wildcard for any URL. So when a non-existent path is requested, the router sees `hasPath` = true (because of the CORS catch-all) and returns 405 Method Not Allowed instead of 404 Not Found.

---

## DX Evaluation: Junior Developer Perspective

### What would confuse a junior dev?

1. **`encapsulate: false` is non-obvious.** The database plugin MUST be registered with `{ encapsulate: false }` for `req.db` to work globally, but nothing tells you this. A junior dev will register `database()` and get `Cannot read properties of undefined (reading 'query')` with no hint about encapsulation.

2. **`parsedBody` vs `body`.** Coming from Express, you'd reach for `req.body`. In Celsian it's `req.parsedBody`. The `req.body` exists but is the raw ReadableStream from the Request API. This will cause silent bugs where `req.body` exists but isn't what you expect.

3. **No type inference on `req.parsedBody`.** It's typed as `unknown`, requiring a cast every time: `const body = req.parsedBody as { title: string }`. Express with TypeScript has the same problem, but Fastify's schema-based typing is much better.

4. **The `send(null)` crash on 204.** A junior dev following any REST tutorial will write `reply.status(204).send(null)` for DELETE endpoints and get an unhelpful 500 error.

5. **Hook behavior differences.** `onRequest` hooks bake into routes at registration time, but `onSend` hooks run from the root context. This means timing of registration matters for some hooks but not others.

### What would work well for a junior dev?

- `app.get/post/put/delete` shorthand — no cognitive overhead
- Reply helpers like `reply.notFound()` — discoverable via autocomplete
- `app.inject()` for testing — no server setup needed
- JSON body parsing is automatic — no `app.use(express.json())` needed

---

## DX Evaluation: Senior Developer Perspective

### What patterns from Express/Fastify are missing?

1. **No middleware signature.** Express's `(req, res, next)` middleware pattern or Fastify's `preHandler` arrays on routes. Celsian has hooks, which work, but there's no `next()` concept. You can return a Response to short-circuit, but you can't easily compose middleware that transforms the request and passes it along.

2. **No request body typing via schema.** Fastify's `schema: { body: Type.Object({...}) }` gives you typed `req.body`. Celsian has schema validation support via `@celsian/schema` but it's not clear how to get TypeScript types from it.

3. **No route-level error handlers.** You can add `onError` hooks globally but not per-route. A route doing DB work might want to catch DB-specific errors differently than an auth route.

4. **No `reply.type()` shorthand.** Setting content-type requires `reply.header('content-type', '...')`. Fastify has `reply.type('text/html')`.

5. **No streaming JSON support.** `reply.stream()` sends an octet-stream. There's no built-in NDJSON or SSE support.

6. **No route-level timeouts.** The global `requestTimeout` exists, but you can't set per-route timeouts (e.g., upload routes need longer than API routes).

### What would make a senior dev choose this?

- **Bun-native:** If Celsian runs well on Bun (using `Bun.serve()` under the hood), that's a differentiator. The standard Web API `Request`/`Response` types mean it could run on Cloudflare Workers, Deno Deploy, etc.
- **Built-in DB analytics:** `trackedPool` + `Server-Timing` header is something Express/Fastify devs manually build every time.
- **Task queue + cron built in:** Most frameworks punt on background jobs. Having `app.task()` + `app.cron()` built in reduces the "which queue library should I use?" decision.
- **Plugin encapsulation:** Fastify's encapsulation model is powerful but confusing. Celsian's simpler version (just `encapsulate: false` flag) is easier to reason about.

### Footguns and Sharp Edges

1. **`decorateRequest` in encapsulated plugins doesn't propagate.** You'd expect `database()` to decorate `req.db` globally, but encapsulation prevents this. The error message gives no hint about encapsulation.

2. **Multipart uploads require `app.handle()` not `app.inject()`.** The inject helper only supports JSON payloads. For multipart, you must construct a `Request` with `FormData` and call `app.handle()` directly. This is a testing ergonomics gap.

3. **No body parsing for custom content types.** If you send `application/xml` or `application/protobuf`, it falls through silently with `parsedBody = undefined`. No hook to register custom body parsers.

4. **Query params are `string | string[]`.** If a query param appears once it's a string, if it appears multiple times it's an array. This dual type is a source of runtime errors — Fastify normalizes this via schema.

---

## Summary Recommendations

### Must fix before beta:
1. Fix `reply.send(null)` on 204/304 status codes
2. Fix CORS catch-all route making all 404s into 405s

### Should fix for good DX:
4. Add `inject()` support for multipart/FormData payloads
5. Make `database()` plugin work without `encapsulate: false` (or document this requirement loudly)
6. Add `reply.type()` shorthand
7. Rename or alias `parsedBody` to `body` (with documentation about the raw body)

### Nice to have:
8. SSE/NDJSON streaming helpers
9. Route-level error handlers
10. Per-route timeout overrides
11. Custom body parser hook registration
12. TypeScript type inference from schema validation
