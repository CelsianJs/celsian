# CelsianJS: Critical Product Review

**Date:** 2026-07-26 · **Version reviewed:** 0.5.5 (published) · HEAD `d50e11b`
**Method:** six parallel Opus research agents. Every finding below was reproduced by executing code, not by reading it.

---

## 1. What is it?

CelsianJS is a TypeScript-first backend web framework built on Web-standard `Request`/`Response`, with a Fastify-style hook lifecycle and plugin encapsulation, distributed as 20 published npm packages (`@celsian/*`, all at 0.5.5) plus 2 private ones. It ships a radix-ish router, schema validation adapters (Zod/TypeBox/Valibot), typed RPC with first-party OpenAPI 3.1, a CLI, and first-party JWT, cache, compress, rate-limit, WebSocket, SSE, durable task queue and cron, with adapters for Node, Bun, Deno, Cloudflare Workers, Lambda, Vercel, Fly and Railway.

It is real, published, and installable today. It is pre-1.0, single-author, five months public, and it is the backend third of "WhatStack" (WhatFW frontend, CelsianJS backend, Vura deploy platform not yet shipped).

---

## 2. Is it real?

**Yes. Emphatically real, not a stub collection.**

| Check | Result |
|---|---|
| `pnpm build` (`tsc -b --force`) | exit 0 |
| `pnpm test` | **1,589 passed / 7 skipped**, 97 files, 7.5s |
| `pnpm typecheck` | exit 0, but it **checks zero files** (see section 6) |
| `pnpm lint` (biome) | 0 errors, 183 warnings hidden by `--diagnostic-level=error` |
| Coverage (`packages/*/src`) | **78.5% lines**, 87.7% functions, 89.1% branches. CI gate is `lines >= 55` against a denominator that includes `examples/` and `benchmarks/` |
| Published to npm | Yes, 20 packages at unified 0.5.5, with **npm provenance** |
| Size budget | core 34.76 kB brotli against a 40 kB limit, enforced in CI |
| Time to hello world | **~25 seconds** via `npx create-celsian@latest`, zero errors |

The scaffold, CLI (`dev`, `build`, `routes`, `generate`, `deploy`), Swagger UI, CSRF flow, JWT flow and RPC flow all work when run from the published registry. CI runs real workerd and Deno smoke tests. The release pipeline uses changesets with lockstep versioning and a post-publish registry verification step. This is a more professional operation than most pre-1.0 frameworks.

**What is genuinely not working:**

- `examples/showcase`, the flagship example, **has never started**. `examples/showcase/src/index.ts:42` passes `"5m"` to `app.cron()`, which requires a 5-field expression. It throws on boot. No CI covers `examples/` at all.
- `@celsian/adapter-node`'s `buildEnd()` (`packages/adapter-node/src/index.ts:40-51`) **throws "not implemented"**. It is published, documented in the package README, and depends on a `@celsian/build` package that does not exist.
- `celsian deploy` generates entrypoints containing `// TODO: Import your routes here` (`packages/cli/src/commands/deploy.ts:53,79,118`). Deploying as-is ships a health-check-only app.
- **3 of the 4 code samples on the landing page do not run.** `site/index.html:861` (rateLimit without `trustProxy` throws at registration), `site/index.html:1022-1044` (the entire Background Tasks sample is fabricated API: `createTaskQueue`, `createCronScheduler`, `cron.add({schedule:'every 1h'})` do not exist), and `site/index.html:1293-1315` (`jwtAuth` is not exported, `app.mount` is undefined, and `app.register(cors, {origin:'*'})` **silently emits no CORS headers**).
- The site is **not deployed**. celsian.dev and celsianjs.com have no DNS. There is no docs site; the "Docs" nav link points at the raw GitHub `docs/` folder, whose first entry is `internal/` containing `SECURITY_AUDIT.md` and `QA-REPORT.md`.

**Verdict: the software is real and the infrastructure around it is strong. The public-facing surface is the part that is broken.**

---

## 3. Is it offering something unique?

### Genuinely differentiated

1. **A durable, retrying background task queue inside the framework.** Hono, Elysia, Fastify, Express, tRPC and oRPC all have nothing here. Nitro has `defineTask` but no durable retrying queue. This is the strongest, most defensible differentiator in the product.
2. **Queue + cron + typed RPC + first-party OpenAPI + multi-runtime, in one MIT package.** Each piece exists somewhere; the combination exists nowhere else.
3. **First-party OpenAPI 3.1 in core that does not fork the routing API.** A direct hit on Hono's weakest point: Hono ships no first-party OpenAPI, and its official `@hono/zod-openapi` is Zod-only and forces `OpenAPIHono` + `createRoute` instead of normal routes.
4. **A zero-dependency superjson-style RPC wire codec** (`packages/rpc/src/wire.ts`) that correctly round-trips Date, BigInt, undefined, Set, Map and RegExp. tRPC needs a superjson transformer for this. Nitro's typed `$fetch` treats it as a known, unfixed correctness hole.
5. **Fastify-style encapsulation and `inject()` testing on a web-standard, portable core.** Fastify has both but cannot leave Node. Hono is portable but has no encapsulation model. (Caveat: see CRIT-1. The encapsulation is currently broken.)
6. **Per-request DB query analytics with `Server-Timing` headers.** Nothing in the comparison set ships this first-party.

### Not differentiated

- Web-standard `Request`/`Response`, multi-runtime adapters, hook lifecycle, plugin system, typed route params, JWT, CORS, compress, ETag, SSE, WebSocket. All table stakes.
- **"Schema-agnostic validation" points the wrong way.** `packages/schema/src/standard.ts` defines a *homegrown* interface that happens to be named `StandardSchema`. It is not `@standard-schema/spec`. `detect.ts` duck-types exactly three libraries; ArkType, Effect, Yup and Joi all throw `SchemaError`. Meanwhile Elysia and h3 consume the real spec natively and get roughly thirty libraries for less code. Using the words "Standard Schema" for something that is not it is the fastest way to lose credibility with the exact audience being targeted.
- **"Zero runtime dependencies" is true of `@celsian/core` only.** `@celsian/jwt` pulls `jose`; `queue-redis` and `ws-redis` pull `ioredis`. Still a strong story, but Hono can make the identical claim.
- **"8 platforms" is inflated.** Fly and Railway are config generators, not runtime adapters; both just run the Node adapter. WebSocket works on only two targets, and the Bun one is not wired up (see below).

**Differentiation verdict: real and unoccupied, but one layer deep, and the depth gaps cluster in exactly the "production infrastructure" story being sold.**

---

## 4. Who is this for?

**Target users.** Small teams and solo builders shipping a TypeScript API that needs background jobs and scheduled work alongside HTTP, who do not want to assemble Fastify + BullMQ + a cron library + tRPC + a swagger generator and own the integration. The specific frustration being solved: "I picked Hono for portability and now I need a job queue, and there isn't one." The second cohort is people who want end-to-end types without adopting tRPC's separate-layer model.

**Adjacent audiences, and what would unlock them.**

| Audience | Blocker today | Unlock |
|---|---|---|
| Serverless / edge teams | Cron is an in-process timer that silently does nothing on Workers and Lambda; rate-limit and cache are memory-only; `queue-redis` uses ioredis over TCP, so Workers cannot be a producer | Compile cron to platform-native triggers (as Nitro does), ship Redis/D1/KV-backed cache and rate-limit stores, add an HTTP-based queue transport |
| Teams using Auth0 / Clerk / Cognito | `@celsian/jwt` is HMAC-only, no RS256/ES256, no JWKS | Asymmetric algorithms + JWKS fetching with caching |
| Anyone with an SRE function | Zero OpenTelemetry anywhere in the repo | First-party OTel tracing across the hook lifecycle |
| Fastify migrators | `docs/migration-from-fastify.md` is 387 lines and the best conversion asset in the repo, and it is **linked from nowhere** | Link it from the README and the site |

**Market positioning.** The gap is real. Hono has no first-party OpenAPI, no cron, no queue, no rate-limit, and Standard Schema stranded at 0.x outside core. Elysia is Bun-first with an unshipped 2.0 churning at exp.50. Fastify cannot leave Node. Nitro/h3 occupies almost exactly this position with the right architecture and the wrong stability profile (h3 publishes a rolling `2.0.1-rc.N` under `latest`, `2.0.0` never released). Encore.ts is container-only and not competing on this axis.

**Position it as: "Hono's portability with Fastify's structure and the batteries Node teams actually assemble by hand: jobs, cron, RPC, OpenAPI."** Not as "another fast framework."

---

## 5. Security audit

Framework-level bugs become vulnerabilities in every app built on the framework, so these are weighted accordingly. Every finding below was reproduced with an executed proof of concept.

### CRITICAL

| ID | Finding | Location |
|---|---|---|
| CRIT-1 | `app.register(plugin)` silently discards the plugin's `onRequest` and `preHandler` hooks. Security plugins become no-ops with no warning. | `packages/core/src/context.ts:71-92,115-123,199-207` |
| CRIT-2 | The README's own rate-limit example is therefore inert. Copy-paste yields zero rate limiting. | `README.md:115` |
| CRIT-3 | Two `jwt()` realms in one app collapse to last-writer-wins. Tenant B's token authenticates on tenant A's routes. | `packages/jwt/src/index.ts:86`, `packages/core/src/context.ts:216-222` |

**CRIT-1.** `register()` creates a child context, but only `onSend` and `onResponse` propagate back to ancestors (`context.ts:199-207`). `onRequest` and `preHandler`, the two hooks every auth, CSRF and rate-limit plugin uses, stay in the child and are never seen by routes registered on the app. Proven:

```ts
const app = createApp();
await app.register(csrf());          // the documented plugin API
app.post("/transfer", () => ({ ok: true }));
// POST /transfer with no CSRF token -> 200 {"ok":true}
// with { encapsulate: false }       -> 403 as intended
```

This voids the framework's stated number-one differentiator. `README.md:12`, `site/index.html:891` and `docs/plugins.md:3` all claim "hooks and decorations never leak across boundaries." The truth is worse than a leak: three of eight hook types leak globally, three are dead when scoped, and only two behave correctly.

**CRIT-2.** `README.md:115` is `await app.register(rateLimit({ max: 100, window: 60_000, trustProxy: true }))` with no `{ encapsulate: false }`. Proven with `max: 2` and six requests from one IP: README pattern gives `200,200,200,200,200,200`; the correct form gives `200,200,429,429,429,429`. `docs/plugins.md:251` documents the trap correctly, but the README is what people copy. Anyone following the front page ships an unprotected login endpoint believing it is throttled.

**CRIT-3.** `REQUEST_CONFIG_KEY` is a module-level Symbol, and `scope: "app"` hoists the decoration to the root context regardless of which encapsulated plugin registered it. Registering `jwt()` twice, the normal way to run two auth realms, makes the second overwrite the first. Proven:

```
B-token on /tenant-a/me -> 200 {"realm":"A"}   <-- cross-tenant bypass
A-token on /tenant-a/me -> 401                  <-- and legitimate users locked out
```

Commit `d574a13` removed the `_lastRegisteredApp` WeakRef fallback but replaced it with an equivalent last-writer-wins global at the root context. The tests added in that commit only cover *separate `CelsianApp` instances*, which is why it passed.

### HIGH

| ID | Finding | Location |
|---|---|---|
| H-1 | `reply.download()` has no root confinement at all. Arbitrary file read. | `packages/core/src/reply.ts:195-224` |
| H-2 | `reply.sendFile()` without `root` performs no traversal check, while the code comment claims it does. | `packages/core/src/reply.ts:174-177` |
| H-3 | `sendFile({ root })` does not resolve symlinks. Symlink escape out of root. | `packages/core/src/reply.ts:164-173` |
| H-4 | Hooks added *after* route registration silently never run. | `packages/core/src/context.ts:73-91`, `app.ts:818` |
| H-5 | WebSocket upgrades bypass all hooks and have **no Origin check**. Cross-site WebSocket hijacking. | `packages/core/src/serve.ts:224-279` |
| H-6 | `compress` drops every `Set-Cookie` on compressed responses. Logout silently fails. | `packages/compress/src/index.ts:79,89,96` |
| H-7 | RPC `decode()` turns a client `__proto__` key into a real prototype assignment. | `packages/rpc/src/wire.ts:85-88` |
| H-8 | `rateLimit` is fully bypassable under `trustProxy: true` without a rewriting proxy, and every doc mandates that config. | `packages/rate-limit/src/index.ts:147-181` |
| H-9 | RPC mutations accept `multipart/form-data`, so they are CSRF-able with a plain cross-origin HTML form. | `packages/rpc/src/router.ts:146-147` |
| H-10 | Response cache key omits Host. Cross-tenant response leak on multi-domain apps. | `packages/cache/src/response-cache.ts:162-165` |
| H-11 | Cache poisoning via unkeyed request headers (`X-Forwarded-Host` and friends). | `packages/cache/src/response-cache.ts:162-178` |

**H-1/H-2 proven:** `GET /d/..%2Fsecret.txt` returns `200 TOP SECRET`. `resolve()` normalizes `..`; it does not constrain anything. Both sites carry the comment "Resolve to absolute path to prevent path traversal," which is false. `README.md:242` shows the rootless `sendFile` form as the primary example.

**H-3 proven:** `public/link.txt -> ../secret.txt`, then `GET /f/link.txt` returns `200 TOP SECRET`, while the lexical `..%2F` attempt correctly returns 403. Matters wherever user uploads land inside the served root.

**H-4 proven:** moving an `addHook('onRequest', ...)` call below a route block during a refactor removes authentication with no signal, no error and no test failure.

**H-5:** the only gate on upgrade is the opt-in `options.onUpgrade`. No Origin check exists anywhere in `serve.ts` or `websocket.ts`. A cookie-session app with `app.ws('/chat')` is readable by `evil.com` via `new WebSocket('wss://victim.app/chat')`, since WebSocket handshakes are not subject to SOP or CORS. Also no connection cap and no `maxPayload` override (ws defaults to 100 MB).

**H-6 proven:** compressed response has `set-cookie: null`; the same route below the compression threshold has the cookie. A `POST /logout` returning >1 KB never clears the session for any gzip-capable client, which is every browser. Threshold- and `Accept-Encoding`-dependent, so it passes local testing.

**H-7 proven:** `?input={"__proto__":{"isAdmin":true},"name":"bob"}` yields `Object.keys(input) === ["name"]` while `input.isAdmin === true`. Object-local prototype substitution, which is precisely what defeats allow-list guards. Core's body parser scrubs these keys correctly; the RPC GET path never reaches that scrub.

**H-8 proven:** 50 requests rotating `X-Forwarded-For` at `max: 3` gives 0/50 blocked. `trustProxy: false` without a `keyGenerator` throws at registration, which is what pushes every example in the repo (`README.md:115`, `docs/plugins.md:246,264,276`, `docs/hooks.md:280`, two `examples/`) to `trustProxy: true`.

**H-10/H-11 proven:** tenant-b served tenant-a's cached body; and one unauthenticated request with `X-Forwarded-Host: evil.attacker.com` permanently serves attacker-controlled `<script src>` to every anonymous visitor for the TTL.

### MEDIUM (16 findings, abbreviated)

Path aliasing (`//admin`, `/./admin`, `/admin//` all route to `/admin`, enabling upstream WAF/ACL bypass, `router.ts:239-248`) · open redirect, including `/\evil.com` which browsers normalize to protocol-relative (`reply.ts:130-141`) · `%2F` in params decodes to `/`, feeding `../` into sendFile (`router.ts:173,182`) · CSRF token not bound to a session and unsigned (`csrf.ts:100-125`) · `X-Real-IP` fallback enables both rate-limit bypass and targeted victim lockout (`rate-limit:173`) · rate-limit eviction is insertion-ordered, so an attacker resets victims' counters (`rate-limit:119-137`) · unbounded attacker-controlled rate-limit key length, ~2 GB retained per window at defaults (`rate-limit:165`) · missing `Vary: Accept-Encoding` on uncompressed responses (`compress:42`) · compress-everything with no filter, so BREACH applies, plus unconditional `content-type` clobbering (`compress:40,59-99`) · TypeBox adapter passes unknown keys through while Zod and Valibot strip them, so swapping schema libraries silently changes whether you have a mass-assignment hole (`typebox.ts:27-29`) · validated `querystring`/`params` output is discarded and `request.query`/`request.params` stay raw, while `body` *does* write back (`app.ts:982-997`) · `/_rpc/manifest.json` and `/_rpc/openapi.json` are unauthenticated, unconditional, and bypass per-procedure middleware (`rpc/router.ts:110-120`) · SSE `event:`/`id:` fields interpolated raw, so event injection (`sse.ts:29-42`) · upload `maxFileSize`/`maxFiles` enforced *after* the full in-memory read, MIME taken from the client, `fileName` unsanitized (`upload.ts:91,107-114`) · Swagger UI loads unpinned `swagger-ui-dist` from jsdelivr with no SRI and `unsafe-inline` CSP (`openapi.ts:267-273`) · no `audience`/`issuer`/`clockTolerance` verification exists in `@celsian/jwt` at all, so a token minted by any service sharing the secret authenticates (`jwt/index.ts:16-19,105-110`) · tokens without `exp` are accepted forever and `sign()` sets no default expiry (`jwt/index.ts:89-103`) · CI third-party actions pinned to floating tags in the job holding `NPM_TOKEN` (`release.yml:19,21,55,57,68`) · `pnpm audit` is `|| true` and is not in `ci-passed`'s `needs` (`test.yml:100-102,175`) · scaffold ships `keyGenerator: () => 'local-scaffold'`, one global rate-limit bucket for all clients (`create-celsian/src/templates/full.ts:264-269`).

### LOW (14 findings, abbreviated)

Cookie `Secure` gated on `NODE_ENV === 'production'` only, and containers routinely omit it · ETag uses a 32-bit non-crypto hash, so collisions give wrong 304s · non-`HttpError` with `statusCode < 500` leaks `error.message` in production · `compressBody` never awaits the writer, so a stream failure is an unhandled rejection that crashes Node · compress threshold compares UTF-16 length, not bytes, varying 3-4x by locale · `Retry-After` can be `0` · RPC 5xx logs via raw `console.error`, bypassing logger redaction · RPC `decode()` recursion has no depth cap · `rate-limit/README.md:3` advertises "sliding-window" for a fixed-window implementation (2x boundary burst proven) · `MemoryKVStore` cache-key flooding evicts hot entries, and sharing one store between sessions and response cache logs users out · session cookie percent-encodes on write but never decodes on read · `deprecate-adapters.yml` exposes `NPM_TOKEN` behind a guessable `workflow_dispatch` input.

### INFO, and the worst finding of the lot

`docs/internal/SECURITY_AUDIT.md:26-40` records the `sendFile`/`download` traversal issues as **"CRITICAL, Fix Applied: added `resolve()` to normalize the path,"** and `docs/internal/FEATURE_PARITY.md:49` states that `download()` "resolves absolute path to guard against traversal." H-1 and H-2 above prove arbitrary file read still works. Documented security guarantees that the code does not provide are worse than no documentation, because they stop the next person from looking.

### Verified secure (partial list, all tested)

JSON body prototype pollution is genuinely blocked with a null-prototype rebuild · default 1 MiB body limit enforced during streaming, so a lying `Content-Length` does not bypass it · query-string and cookie prototype pollution blocked · CRLF header injection blocked (`reply.ts:66`) · `Content-Disposition` injection blocked · `sendFile({root})` blocks lexical traversal including the sibling-prefix case · static serving in `serve()` decodes then resolves then boundary-checks, in the correct order · Slowloris defaults present (60s/30s timeouts) · `x-forwarded-host` is allow-listed, not blindly trusted · router uses `Map`s throughout, so no prototype-chain resolution · `alg:none` rejected and algorithms pinned on *every* JWT verify path · no JWKS support means no SSRF surface · `createJWTGuard` fails closed on every malformed-token variant tested · cross-*app* JWT isolation holds · credentialed requests bypass the shared cache on both read and write · `Set-Cookie` responses are never stored, and the whole response is rejected rather than the header stripped · `Vary: *` and `Cache-Control: private/no-store` correctly prevent storage, re-checked on read · session IDs use `crypto.getRandomValues` with 192 bits, no fixation, `regenerate()` closes the race · cookie injection blocked by RFC 6265 octet enforcement · no request-body decompression anywhere, so zip bombs do not apply · no `eval`, `new Function`, `vm.runIn`, or `RegExp` built from request data in any runtime package · `TAG_REGEXP` deliberately does not reconstruct a `RegExp` from wire data, with the ReDoS rationale in-comment · RPC procedure lookup uses a `Map`, so `__proto__` returns 404 · RPC production error sanitization is correct · `detect.ts` fails loud with no silent-passthrough path · npm provenance correctly enabled via OIDC · no secrets anywhere in the repo, and the scaffold **enforces** its placeholder-secret rejection at boot in production rather than just documenting it.

**Security verdict: not usable as a security boundary today. The plugin system silently voids `onRequest`/`preHandler` security hooks, the README ships a rate limiter that blocks nothing, two JWT realms in one app cross-authenticate, and `download()`/`sendFile()` grant arbitrary file read while the code comments and internal audit docs assert those holes are fixed. Underneath that, the defensive work that *was* done is unusually thorough and correct.**

---

## 6. Engineering quality

### Two CI gates are no-ops, and both were proven

**`pnpm typecheck` checks zero files.** Root `tsconfig.json:2` is `"files": []` with 22 project `references`, and `tsc --noEmit` does not traverse references (that needs `-b`). The program is empty. Proof: appending `const __probe: number = "definitely not a number"` to `packages/core/src/errors.ts` left `pnpm typecheck` exiting **0 in 0.26s**, while `tsc -b packages/core` correctly reported `TS2322`. This gate runs in `test.yml:70` **and** `release.yml:36`. Commit `74898eb`'s message asserts "typecheck clean"; that claim has never been verifiable. The fix is one flag: `tsc -b --noEmit`.

**All 43 type-inference tests are decorative.** `vitest.config.ts` has no `typecheck` block, and every `packages/*/tsconfig.json` uses `"include": ["src"]`, so no tsconfig sees a test file. `expectTypeOf` at runtime is a no-op. Proof: `expectTypeOf<string>().toEqualTypeOf<number>()` and `ExtractRouteParams<"/users/:id">` asserted as `{totallyWrong: number}` **both passed**. 56 assertions across `packages/core/test/type-inference.test.ts` and `packages/rpc/test/procedure.test.ts` cannot fail. The marquee "TypeScript-first" claim is the least-tested thing in the repo, which is precisely how the three broken-inference bugs below survived.

### What is great

- **Test volume and quality.** 1,589 tests across 97 files in 7.5 seconds, at 78.5% lines / 89.1% branches on package source. They are real `app.inject()` and real-HTTP behavior tests, and there is **no mock-the-thing-under-test anywhere**: the only two `vi.mock` calls target `ioredis`, a genuine external dependency. Highlights include a proper SSRF table (`edge-router/test/security.test.ts:10-63`) and a real lost-update concurrency detector (`rate-limit/test/rate-limit.test.ts:181-190`).
- **Type-safety discipline is top-decile.** 27 `any` in roughly 14k lines of src (mostly legitimate runtime-detection casts), **zero `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`**, `strict: true`. The discipline is real; it just is not enforced by anything.
- **Only 3 bare `throw new Error(`** in all of src, against a project rule forbidding them.
- **`app.ts` is genuinely well-optimized** and the optimizations are real, not cargo-culted: manual URL parsing that avoids `new URL()` (`:549-587`), lazy `fullUrl`, lazy cookie parsing via a `defineProperty` getter (`:676-685`), skip-if-empty guards on every hook array, pre-stringified 404/405 bodies (`:53-58`), request-ID and child-logger construction only when logging is on.
- **Release engineering.** Changesets with lockstep `fixed` versioning, npm provenance via OIDC, size-limit budgets enforced in CI, real workerd and Deno smoke jobs, and a post-publish `verify:registry` step whose output artifact is committed.
- **Error class hierarchy** (`errors.ts`) is clean and the assertion helpers are thoughtful (`assertPlugin` prints what you actually passed).
- **Benchmark disclosure culture is real and rare.** `RESULTS.md` is dated, states Node version and platform, names **Fastify the winner in bold**, and contains a voluntarily published self-correction of an earlier bogus memory table. (The throughput data itself is a serious problem. See "what is bad.")
- **Error messages, where they exist, are best in class.** "Task 't' enqueued but no worker is running. Call app.startWorker() or use serve()" beats anything Fastify prints, and `rate-limit/src/index.ts:191-194` ships the *security rationale* for its own validation ("would silently disable rate limiting (fail open)").

### What is good

- Hook lifecycle implementation (`hooks.ts`, 102 lines) is small and correct, including fire-and-forget rejection capture.
- Body parser, cookie parser and request builders consistently use null prototypes and key blocklists.
- The router's static-route fast-path map and frozen shared `EMPTY_PARAMS` are the right micro-optimizations.
- Scaffold quality: the `full` template is a real starting point with 19 files, 10 passing tests, a Dockerfile, and a 250-line README that pre-empts the CSRF confusion with a working curl recipe.

### What is bad

- **The headline type-safety claim is broken in three separate places, and none of it is tested.**
  1. `packages/core/src/app.ts:164-272`: the `CelsianApp` route-method overloads declare `<T, TBody, TQuery>` and then never reference `TBody` or `TQuery`. The correct signatures using `InferOutput<TBody>` exist only on `PluginContext` (`types.ts:232-273`). Net effect: `app.post(...)` on the instance loses body typing, while the identical call inside a plugin function gets it. The README quickstart uses the instance form and papers over it with `req.parsedBody as {...}` casts.
  2. `packages/core/src/types.ts:176`, repeated about ten times: `TQuery extends unknown ? Record<string, string|string[]> : InferOutput<TQuery>`. `T extends unknown` is always true, so the querystring branch is unreachable by construction. No schema can ever type `parsedQuery`.
  3. `packages/schema/src/standard.ts:30-37`: `InferOutput` matches StandardSchema, `_output` and `_type`. TypeBox 0.34 exposes `static`. So `InferOutput<TObject>` is `unknown`, and **TypeBox is the schema library the default template installs and uses**. The generated README's "parsedBody is fully typed, no cast needed!" is false for its own chosen library.
  `packages/core/test/type-inference.test.ts` asserts only `ExtractRouteParams`, the one piece that works. There is no `expectTypeOf` for `parsedBody` or `parsedQuery` anywhere.
- **`schema.response` is in the public type (`types.ts:114`) and never validated.** `validateRequest` (`app.ts:972-998`) handles body, querystring and params only. A route declaring `response: {200: z.object({must: z.string()})}` returns `{"wrong":123}` with a 200.
- **The router silently accepts three classes of mistake.** Duplicate route registration overwrites (`router.ts:101`); sibling param-name collisions mean `/x/:id/one` plus `/x/:slug/two` makes both emit `params.id` and leaves `params.slug` undefined; and `/admin`, `//admin`, `/admin/`, `/./admin` all match with no way to turn it off. Fastify throws on the first two.
- **`CelsianRequest` and `CelsianReply` both carry `[key: string]: unknown` index signatures** (`types.ts:53,57`). For a TypeScript-first framework, that defeats typo detection on the two most-touched objects in every handler.
- **Missing decorators produce a raw `TypeError`**, and `@celsian/jwt`'s declaration merging means TypeScript claims `app.jwt` exists whether or not you registered the plugin. The types actively lie, then you get `Cannot read properties of undefined`.
- **The published performance claim does not reproduce, and the harness cannot support the precision it prints.** `README.md:15,103,439`, `RESULTS.md:24` and five cards on `site/index.html` all claim 1.25x to 2.3x faster than Express. Across three harness runs, **Express beat CelsianJS in 9 of 10 intra-run scenario comparisons.** The reviewing machine was loaded, so the reversal is not settled, but the methodology is indefensible regardless of hardware: `run.ts:76` takes only `result.requests.average` and **never checks `errors`, `timeouts` or `non2xx`** (one run recorded 0 req/s and was printed as a normal result); there is no warmup (300ms sleep, then measure); N=1 with stddev discarded, yet numbers are published to five significant figures; and every framework runs in fixed order in one shared process competing with the load generator for CPU, which is the exact bias `run.ts:105-108` documents as the reason the memory table was wrong and then never fixes for throughput. Independent tell: Express is published at ~22K req/s in all five structurally different workloads. That flatness is a measurement artifact.
- **Five tests on the auth surface have zero `expect()` calls.** `packages/jwt/test/poc-audit.test.ts` `console.log`s the results of `alg:none` forgery (`:70-72`) and cross-tenant token replay (`:29-32`), with the repo's only try/catch swallow at `:83-87`. The actual behavior is correct (both return 401, verified), so this is an unguarded regression risk rather than a live hole. But `alg:none` acceptance would not fail the build today.
- **The flagship feature drops data, and the default backend loses it silently.** `task.ts:161-167` logs and **acks** permanently-failed jobs: no dead-letter queue, no failure hook, zero repo hits for DLQ. Worse, `MemoryQueue`, the default backend (`app.ts:72`), is **at-most-once**: `queue.ts:44-52` moves a job to `inFlight` and nothing ever reclaims it, while `stop()` gives up after 10s. Out-of-the-box behavior is silent job loss on shutdown.
- **183 lint warnings are invisible to CI** because `lint` runs `--diagnostic-level=error`.

### What needs work

- **Data integrity is the weakest area by a distance.** Beyond the DLQ and at-most-once defaults above: `promoteDelayed()` (`queue-redis/src/index.ts:238-251`) is **not atomic**, and its comment claiming "use a pipeline for atomicity" is factually wrong, since `ioredis.pipeline()` is batching, not `MULTI`. Two workers both `zrangebyscore` the same set and both `LPUSH`, so **every delayed retry duplicates**; and `zremrangebyscore` deletes by score range rather than the members read, so a concurrent push in that window vanishes. The 30s visibility timeout (`queue-redis:104`) against no default task timeout (`task.ts:12`) guarantees any task over 30s is reclaimed and run concurrently, with no heartbeat or extend API, and reclaim reuses the same id so worker A's ack deletes worker B's in-flight entry. There is no cache stampede protection (no single-flight, no SWR), so N concurrent cold-key requests mean N origin executions. And `session.ts:192` persists a 24h entry for every cookie-less request against a 10,000-entry LRU, so a crawler evicts every logged-in session in 10k requests. Bright spot: the rate limiter's synchronous read-modify-write (`rate-limit:86-117`) carries an explicit comment warning against adding an `await`. Someone thought hard there.
- **`app.ts` is a god object**: 1,028 lines, 46 methods, owning router, hooks, task registry, queue, worker, cron, WebSocket registry, content-type parsers, error handlers, health, decorations and the full request lifecycle. HTTP plus background jobs plus cron plus WebSockets in one class. No circular deps, at least.
- **Plugin-scoped `decorateRequest` is a silent no-op.** `context.ts:216-222` writes to the child context; `app.ts:665-666` only ever reads `rootContext.requestDecorations`, and nothing merges them. The *default scope* of a public API does nothing. (This is the same root cause as CRIT-3, approached from the other side.)
- **Sync throws in `onResponse` vanish.** `runHooksFireAndForget` (`hooks.ts:98-100`) logs async rejections but silently swallows synchronous ones. There is also **no `unhandledRejection` or `uncaughtException` handler anywhere**, only SIGTERM/SIGINT.
- **Two timer leaks.** The SSE keep-alive (`sse.ts:97`) is not `unref`'d, so it is one live timer per connection. And `task.ts:137-146` **never clears the timeout timer**, so a task configured with `timeout: 3_600_000` that finishes in 1ms holds an armed hour-long timer; the timeout also only loses the race without cancelling the handler, so the task keeps running while the worker nacks it for retry.
- **Redis is never exercised.** All 9 real `queue-redis` tests gate on `REDIS_URL`, and `grep -rn REDIS .github/` returns nothing. They are permanently skipped, so the package is validated only against a fake with hand-reimplemented Lua. **The actual Lua at `queue-redis/src/index.ts:34,52` is executed by nothing.**
- **28% of the suite lives in `docs/internal/`** and imports `../../../packages/core/src/app.js`, bypassing every `exports` map. Nothing verifies the published artifact.
- **Dead code in the bundle:** `core/src/jsx*.ts` and `serializer.ts` (271 lines) sit at 0% coverage and are not exported from `index.ts` or `package.json`.
- **Coverage gate is 55% against actual 78%.** `adapter-bun`, `adapter-deno` and `platform` have **zero tests**; the first two are published. `adapter-deno` has 0.0% executed lines. That is exactly why the Bun WebSocket bug went undetected. `cli` sits at 38.3% over 703 lines.
- **`packages/platform` is not a stub** (CLAUDE.md is out of date; it contains real `execSync` wrappers around `wrangler`/`vercel`/`railway`), but it has 0 tests, 0% coverage, is `private: true`, and sits at 0.4.0 while everything else is at 0.5.5. Same story for `edge-router` at 0.3.18. Decide: ship them or delete them.
- **Examples are not in CI at all.** `grep examples .github/workflows/*` returns nothing. That is how the flagship example came to have never started, and how `celsian routes` came to fail on all 14 of them (none export their app, though the scaffold template does it correctly).
- **In-memory only** for cache, rate-limit and sessions, with unbounded-key and LRU-eviction DoS surfaces in each. On serverless, which is the advertised deployment story, an in-memory rate limiter is close to meaningless.
- **Zero OpenTelemetry** anywhere in the repo.
- Root `package.json` is stuck at 0.5.2 while npm is at 0.5.5, and **`CHANGELOG.md` is stale by three releases**, including one that contains a cross-user response-disclosure security fix that appears in no changelog.
- Startup line logs twice (once as JSON via `app.log.info`, once as a bare `console.log` at `serve.ts:315-316`), so `logger: true` puts a non-JSON line in the log stream on every boot.

---

## 7. Competitive landscape

| | **CelsianJS 0.5.5** | **Hono 4.12** | **Elysia 1.4** | **Fastify 5.10** | **Nitro 3 / h3 2** |
|---|---|---|---|---|---|
| Stability | pre-1.0 | stable since 2024-02, no breaking major in 2.5y | 1.4 stable, **2.0 unshipped at exp.50** | stable, tightest cadence | **neither is stable** |
| Core model | Web standard | Web standard | Web standard | `node:http` | Web standard |
| Workers / Lambda / Vercel | yes / yes / yes | yes / yes / yes | **experimental / unofficial / yes** | **no / no / no** | yes / yes / yes |
| Deploy targets | 6 real + 2 generators | 9 in-core | Bun-centric | Node | **~35 presets** |
| Real Standard Schema | **no** (homegrown iface, 3 libs) | via 0.x pkg, not in core | **yes, native, mixable** | no (Ajv) | **yes, native** |
| First-party OpenAPI | **yes, 3.1, in core** | **none** | **yes, plus `fromTypes()`** | yes | experimental |
| Typed RPC client | **yes, first-party** | `hc`, type-perf issues | Eden Treaty | **none** | response-only, **JSON-lossy** |
| Rich wire types (Date/Map/Set) | **yes, zero-dep** | no | partial | n/a | **no, known unsound** |
| **Task queue** | **yes, retries + backoff + Redis** | **none** | **none** | **none** | `defineTask`, not durable |
| **Cron** | yes, but **no-op on serverless** | **none** | plugin | plugin | **compiles to native CF/Vercel cron** |
| Rate limit | first-party, **memory only** | **none official** | **none official** | `@fastify/rate-limit` | **none** |
| Cache | first-party, **memory only** | built-in (Web Cache API) | **none official** | plugin | **unstorage, 20+ drivers, SWR** |
| JWT | first-party, **HMAC only** | `hono/jwt` + **`hono/jwk`** | official | plugin | **none** |
| OpenTelemetry | **none** | `@hono/otel` | **official** | ecosystem | ecosystem |
| Static file middleware | **none** | `serveStatic` | plugin | `@fastify/static` | public assets |
| Core runtime deps | **0** | **0** | 4 + 4 peers | 15 | 14 / **2 (h3)** |
| Perf | claims 74% of Fastify JSON, **does not reproduce** | RegExpRouter | Bun-dependent | reference | **92.6% of Fastify** |
| License | MIT | MIT | MIT | MIT | MIT |

Two notes on the set: **Hattip is dead** (all 31 packages frozen at 0.0.49 since 2024-11, hattip.dev has no DNS, still ships an adapter for a platform that shut down in 2024) and should be dropped from any comparison. **ts-rest is stalled**, with no commits since 2026-02 and a docs site advertising Standard Schema and Zod 4 that exist only in an unreleased RC.

Also worth knowing: TechEmpower was **archived on 2026-03-24**, Round 23 is the last round ever. That makes a reproducible in-repo benchmark harness a genuine asset rather than table stakes. But `benchmarks/server-hono.ts` exists and Hono is **absent from `run.ts`**, so it is dead code. Publishing an "honest benchmarks" table that omits the nearest architectural competitor invites the obvious question.

---

## 8. What to fix now

### Before anyone sees this

1. **CRIT-1.** Propagate `onRequest`/`preHandler` to ancestors the way `onSend` already does, or (better) defer route hook binding to `ready()` so registration order stops being load-bearing, and hard-fail when a child context registers a request hook but owns zero routes. `packages/core/src/context.ts:71-92,199-207`.
2. **CRIT-2.** Add `{ encapsulate: false }` to `README.md:115,117` today, as a stopgap, then let the CRIT-1 fix retire the footgun.
3. **CRIT-3.** Remove `scope: "app"` from `packages/jwt/src/index.ts:86` and bind config to the registering encapsulation context. Add the regression test the existing suite lacks: **two realms on one app**, not two apps.
4. **H-1/H-2/H-3.** Add a `root` option to `download()`, make root confinement mandatory (or default to `cwd`), delete the two false "prevents path traversal" comments, and use `realpath()` on both sides of the prefix check.
5. **H-5.** Origin allow-list on WebSocket upgrade, rejecting by default, plus run the root `onRequest` chain on upgrades.
6. **H-6.** Wrap the `Response` returned by the original reply method instead of rebuilding headers from `reply.headers`. Preserve repeated `Set-Cookie`.
7. **H-7.** `Object.create(null)` plus the key blocklist in `packages/rpc/src/wire.ts:85-88`, or export core's `scrubPrototypePollution` and route the RPC GET path through it.
8. **H-10/H-11.** Add `url.host` to the default cache key, and eagerly partition on the host-rewriting header family alongside `origin`.
9. **Correct the false claims.** `README.md:12`, `site/index.html:891` and `docs/plugins.md:3` ("hooks never leak") until CRIT-1 lands. `rate-limit/README.md:3` (sliding vs fixed). `docs/internal/SECURITY_AUDIT.md:26-40` and `FEATURE_PARITY.md:49`, which mark unfixed traversal bugs as fixed.
10. **Fix the three broken landing-page samples** (`site/index.html:861,1022-1044,1293-1315`). One of them fails silently with no CORS headers, which is the worst kind.
11. **Re-run or retract the Express benchmark claim.** It appears in three places in the README, in `RESULTS.md`, and on five landing-page cards, and it did not reproduce here. Anyone in diligence can run `pnpm bench` themselves in three minutes. Fix the harness first (warmup, N>=5 with stddev, assert `errors`/`timeouts`/`non2xx` are zero, separate processes, randomized order), then republish whatever the numbers actually say. The self-correction already in `RESULTS.md` proves this project can do that well.
12. **Make `pnpm typecheck` real:** `tsc -b --noEmit`, in both `test.yml:70` and `release.yml:36`. This is a one-flag change that immediately turns 43 decorative type tests into real ones (after adding `typecheck: {enabled: true}` to `vitest.config.ts` and including `test` in the package tsconfigs). Expect it to go red; that is the point.
13. **Add assertions to `packages/jwt/test/poc-audit.test.ts`.** The behavior is already correct; it just is not guarded. Five zero-assertion tests on the `alg:none` and cross-tenant surface is the worst place in the repo to have them.
14. **Wire up Bun WebSockets or stop advertising them.** `createBunServeOptions` (`packages/adapter-bun/src/index.ts:100-112`) never sets the `websocket` key, so `server.upgrade()` cannot succeed, while README.md:126,354 and the package README all document it as working.

### Before launch or promotion

15. **Fix type inference.** `app.ts:164-272` to actually use `InferOutput<TBody>`; `types.ts:176`'s always-true conditional; TypeBox `static` support in `schema/src/standard.ts:30`. Item 12 is a prerequisite, otherwise the regression tests still cannot fail.
16. **Validate `schema.response`** or remove it from the public type.
17. **Fix the task queue's data integrity.** A dead-letter queue and failure hook; `promoteDelayed()` rewritten as a single Lua script (the current `pipeline()` is batching, not `MULTI`, so delayed retries duplicate); a default task timeout below the 30s visibility timeout, plus a heartbeat/extend API; and reclaim that does not reuse the job id, so one worker's ack cannot delete another's in-flight entry. Then make `MemoryQueue` at-least-once, or document loudly that the default backend loses jobs on shutdown.
18. **Run the Redis tests in CI.** All 9 are permanently skipped behind `REDIS_URL`, so the shipped Lua has never executed. Add a Redis service container.
19. **Ship distributed stores** for cache and rate-limit (Redis at minimum), add cache stampede protection (single-flight or SWR), separate the session store from the response cache, and stop persisting a 24h session for every cookie-less request.
20. **Add asymmetric JWT and JWKS.** Without RS256/ES256 you cannot verify an Auth0, Clerk or Cognito token.
21. **Put `examples/` in CI**, fix `examples/showcase/src/index.ts:42`, make every example export its app so `celsian routes` works, and delete `examples/qa-test/` from the public folder.
22. **Throw on duplicate route registration and on sibling param-name collisions.** Fastify does; silent data corruption is worse than a startup error.
23. **Fix `decorateRequest`'s default scope**, which is currently a silent no-op, and stop `onSend`/`onResponse` from hoisting to every ancestor. Add `unhandledRejection`/`uncaughtException` handlers, and stop `runHooksFireAndForget` swallowing sync throws.
24. **Clear the task timeout timer** (`task.ts:137-146`) and `unref` the SSE keep-alive (`sse.ts:97`).
25. **Deploy the site and build a real docs site.** Move `docs/internal/` and `SPRINT-PLAN.md` off the public docs path.
26. **Write real READMEs** for `core` (29 lines), `cli` (15), `schema` (15) and `create-celsian` (15). Those are npm listing pages that currently say nothing.
27. **Pin CI actions to SHAs** in the job holding `NPM_TOKEN`, make `pnpm audit --prod --audit-level=high` blocking and part of `ci-passed`, and drop `--diagnostic-level=error` from lint so the 183 warnings become visible.
28. **Make `celsian dev` load `.env`** (it currently does not, while the scaffold's own `npm run dev` does, so the CLI silently falls back to the dev JWT secret), and make `celsian deploy` import the user's app instead of emitting a TODO.
29. **Fix or delete `adapter-node buildEnd()`** and the `defineConfig({build:{adapter}})` story documented in four places against a config type that has no `build` key.
30. **Sync `CHANGELOG.md`** through 0.5.5, including the security fix, and fix the root `package.json` version.

### Can wait

31. Adopt the real `@standard-schema/spec` and delete the hand-written detectors. Less code, roughly thirty libraries instead of three, and it retires a claim that currently reads as a misrepresentation.
32. OpenTelemetry across the hook lifecycle.
33. Compile cron to platform-native triggers on Workers and Vercel.
34. Static file middleware.
35. RPC subscriptions, batching, typed errors, and context-narrowing middleware.
36. Add Hono to `benchmarks/run.ts`. The harness already has the server file, it is just not wired in.
37. Raise the coverage gate to match reality, scope it to `packages/*/src`, and add tests to the two published zero-test packages (`adapter-bun`, `adapter-deno`).
38. Delete or export the dead `jsx*.ts` and `serializer.ts` (271 lines at 0% coverage, shipped in the bundle).
39. Test against the published `exports` map, not `../../../packages/core/src/app.js`.
40. Name the actual limit in the five `HttpError(413, "Payload Too Large")` messages in `body-parser.ts`.

---

## 9. The verdict and path forward

### What is strong

The engineering craft is real and above the median for pre-1.0 frameworks. 1,589 fast behavior tests at 78% line coverage with no mock-the-subject anti-pattern, 27 `any` and zero type suppressions across 14k lines, npm provenance, size budgets, cross-runtime workerd/Deno/Bun smoke tests, changesets with lockstep versioning, and a private-package publish assertion. The first-run experience beats most competitors: 25 seconds from `npx` to a working API, with a generated README that pre-empts the confusing parts. `app.ts` shows someone who understands where the time goes in a request. The error messages for tasks, cron and rate-limit config are better than Fastify's, and one of them ships its own security rationale. The `RESULTS.md` self-correction shows a real willingness to publish inconvenient findings, which is the disposition that makes everything else in this review fixable.

The strategic position is legitimate and unoccupied: nobody else ships a durable retrying task queue and cron next to typed RPC and first-party OpenAPI on a portable web-standard core.

### What is holding it back

- **The number-one claimed differentiator does not work.** Plugin encapsulation silently voids the request hooks that security plugins depend on, and the front-page rate-limit example is a no-op because of it.
- **Two JWT realms in one app cross-authenticate.** Multi-tenant is off the table until that is fixed.
- **Arbitrary file read** via `download()` and `sendFile()`, with internal audit docs asserting it is fixed.
- **"TypeScript-first" is roughly one-third true, and nothing was watching.** Params infer beautifully. Body, query and response do not, in every registration form, and the default template's own schema library cannot infer at all. It survived because `pnpm typecheck` checks zero files in both CI workflows and all 43 type-inference tests are structurally incapable of failing.
- **The published performance claim does not reproduce**, and the harness that produced it has no warmup, N=1, no error checking, and shared-process contention, while printing five significant figures. This is the finding most likely to be discovered by someone else first, and it takes them three minutes.
- **The flagship feature loses data three ways.** Permanently-failed jobs are acked and dropped, delayed retries duplicate because `promoteDelayed()` is not atomic, and the default in-memory backend is at-most-once and silently loses in-flight jobs on shutdown.
- **The batteries are shallow where the pitch is deepest.** Cron is a no-op on the serverless targets being advertised, cache and rate-limit are memory-only, JWT cannot verify a token from any mainstream identity provider, and there is no OpenTelemetry.
- **The public surface undermines the private quality.** Three of four landing-page samples do not run, the site is not deployed, there is no docs site, the flagship example has never started, and four npm listing pages are stubs.

The uncomfortable pattern: the parts nobody sees are excellent, and the parts everybody sees first are broken.

### Strategic advice: launch strategy

1. **Do not promote anything until CRIT-1, CRIT-3, H-1/H-2/H-3 and the benchmark claim are resolved and released as 0.6.0.** A framework that silently disables its own security plugins is one blog post away from being the cautionary example, and an unreproducible performance claim on the front page is the fastest way to lose an evaluator permanently. Ship the fixes, publish a `SECURITY.md` advisory for the encapsulation and JWT-realm bugs, correct the internal audit docs, and re-run or retract the Express numbers. Being the project that found and disclosed its own bugs is a credibility asset; being the project someone else found them in is not. `RESULTS.md` already proves this project can do exactly that.

2. **Make the task queue the entire pitch, and make it bulletproof first.** Not "another fast framework," not "TypeScript-first." The headline is: *"Hono's portability, Fastify's structure, and the job queue neither of them has."* Before that headline can survive scrutiny it needs a dead-letter queue, a failure hook, and a Redis-backed rate limiter and cache so the serverless story is not hollow. Then write the one blog post that lands it: **"Why your Hono app needs a second service (and how to delete it)"**, with a runnable repo showing an email-sending API that retries, backs off, and dead-letters, deployed to Fly, in under 60 lines.

3. **Fix the type-safety story, then demo it in a 40-second video.** End-to-end inference from `schema.body` to handler to RPC client is the thing that converts tRPC users, and right now it works only in the plugin form and never with TypeBox. Once fixed, an autoplay terminal-and-editor clip on the landing page showing a schema change propagating to a client-side type error is worth more than the entire feature table.

4. **Fix the Standard Schema claim before launch, because it is the one an expert will catch.** Adopting `@standard-schema/spec` deletes code, adds roughly thirty libraries, and removes a phrase that currently reads as either a misunderstanding or a misrepresentation to exactly the audience being courted. This is a two-day job with a disproportionate credibility payoff.

5. **Where to launch, concretely.** Ship 0.6.0 with the fixes, deploy the site, then: a Show HN titled around the queue, not the framework ("Show HN: CelsianJS, a TypeScript API framework with a built-in durable job queue"); r/node and r/typescript (skip r/javascript, wrong crowd); the Bun and Deno Discords, since multi-runtime is a real differentiator there; and a direct, non-promotional issue or discussion on `honojs/hono#4199` (the open Standard Schema issue) once your own implementation is spec-compliant, which puts the project in front of exactly the right people without being a drive-by ad. Pair the launch with the migration guide (`docs/migration-from-fastify.md`), which is the best asset in the repo and is currently linked from nowhere.

---

## 10. Rating

# 6/10

Genuinely well-engineered underneath: 1,589 passing behavior tests at 78% coverage with no mocked subjects, near-zero type escapes, provenance-signed releases, size budgets, real cross-runtime CI, a hand-optimized request path, and a 25-second time-to-hello-world that beats most of the competition. The strategic wedge (a durable task queue inside a portable web-standard framework) is real and unoccupied.

It scores a 6 rather than an 8 because the three things it claims loudest are the three that do not hold. Plugin encapsulation silently voids security hooks, which makes the README's own rate-limit example a no-op. "TypeScript-first" inference works for route params but not for body, query or response, including with the default template's own schema library, and it went unnoticed because `pnpm typecheck` checks zero files and every type test is incapable of failing. And the published "1.25x to 2.3x faster than Express" claim does not reproduce, from a harness with no warmup, N=1, and no error checking. Add arbitrary file read in `download()`/`sendFile()` that the internal audit docs incorrectly mark as fixed, two JWT realms that cross-authenticate, a task queue that drops and duplicates jobs, and three of four landing-page samples that do not run.

None of this is architectural. Every finding above is a bounded, tractable fix, several are one-line, and the underlying craft is strong enough that a focused 0.6.0 could plausibly land this at an 8.
