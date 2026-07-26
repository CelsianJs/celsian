# Sprint Plan: CelsianJS 0.6.0 Hardening

Generated: 2026-07-26
Based on: `PRODUCT-REVIEW-2026-07-26.md` (six-agent audit, all findings reproduced by executed PoC)
Supersedes: `SPRINT-PLAN.md` (0.5.2, dated 2026-06-09)

## Sprint goal

Make every claim CelsianJS makes on its front page true, and make the framework safe to use as a security boundary.

## Success criteria

- [ ] All 3 CRITICAL security findings fixed, with regression tests that fail without the fix
- [ ] All 11 HIGH security findings fixed
- [ ] `pnpm typecheck` actually checks files; type tests can actually fail
- [ ] Body/query/response type inference works in every registration form, including TypeBox
- [ ] Task queue does not drop or duplicate jobs
- [ ] No claim in README, `site/index.html`, package READMEs or `docs/internal/` is false
- [ ] `pnpm build`, `pnpm test`, `pnpm typecheck` all green at the end

## Deliberately out of scope

| Item | Why |
|---|---|
| Adopt `@standard-schema/spec` (#31) | Correct call long term, but it changes public validation behavior. Deserves its own release. |
| OpenTelemetry (#32) | New feature surface, not a fix. |
| Cron compiled to native CF/Vercel triggers (#33) | New feature. Documenting the current serverless no-op is in scope. |
| Static file middleware (#34) | New feature. |
| RPC subscriptions, batching, typed errors (#35) | New features. |
| Deploying the site | Outward-facing action, Kirby's call. Content fixes are in scope. |

## Dev tracks

Strict file ownership. No two tracks touch the same file.

### Track 1: Core encapsulation, hooks, lifecycle, type inference
**Owns:** `packages/core/src/{context,app,hooks,types}.ts` + their tests
CRIT-1 hook propagation · H-4 hooks-after-routes · `decorateRequest` default-scope no-op · `onSend`/`onResponse` ancestor hoisting · sync-throw swallow in `runHooksFireAndForget` · `schema.response` validation · validated query/params write-back · type inference (`app.ts:164-272` overloads, `types.ts:176` always-true conditional) · `expectTypeOf` regression coverage

### Track 2: Core HTTP surface
**Owns:** `packages/core/src/{reply,router,sse,cookie,error-handler,body-parser,request}.ts`, `packages/core/src/plugins/**`
H-1/H-2/H-3 `download()`/`sendFile()` traversal + symlink · M-2 open redirect · M-1 path aliasing · M-3 `%2F` params · duplicate-route and param-collision throws · M-13 SSE injection · M-14 upload limits/MIME/filename · M-4 CSRF session binding · M-15 Swagger SRI + pinning · L-1 cookie Secure · L-2 ETag hash · L-3 error leak · 413 message quality

### Track 3: Server runtime and adapters
**Owns:** `packages/core/src/{serve,websocket}.ts`, `packages/adapter-*/**`
H-5 WebSocket Origin check + hooks on upgrade + `maxPayload` + connection cap · Bun WebSocket wiring · `adapter-node` `buildEnd()` · duplicate startup log · `unhandledRejection`/`uncaughtException` handlers · `adapter-deno` bare `Error` · tests for the two published zero-test adapters

### Track 4: Auth, cache, rate-limit, compress
**Owns:** `packages/{jwt,cache,rate-limit,compress}/**`
CRIT-3 JWT realm collapse (plugin side) · JWT audience/issuer/clockTolerance · default token expiry · `poc-audit.test.ts` assertions · asymmetric JWT + JWKS · H-10/H-11 cache Host key + poisoning · cache stampede · session/cache store separation · H-8/M-5/M-6/M-7 rate limiter · Redis-backed rate-limit and cache stores · H-6 compress `Set-Cookie` · M-8/M-9/M-16 compress · L-5/L-6/L-7

### Track 5: RPC and schema
**Owns:** `packages/{rpc,schema}/**`
H-7 `wire.ts` prototype assignment · H-9 multipart CSRF + Origin check · M-12 introspection gating · M-10 TypeBox unknown keys · TypeBox `static` support in `InferOutput` · L-8 logger · L-9 recursion depth cap

### Track 6: Queue, tasks, cron data integrity
**Owns:** `packages/core/src/{task,queue,cron}.ts`, `packages/{queue-redis,ws-redis}/**`
Dead-letter queue + failure hook · `promoteDelayed()` atomicity via Lua · visibility timeout vs task timeout + heartbeat/extend · reclaim id reuse · `MemoryQueue` at-least-once · uncancelled task timeout timer · document cron's serverless no-op · unskip Redis tests

### Track 7: CI, build, benchmarks, docs, site, examples, CLI
**Owns:** `.github/**`, `tsconfig*.json`, `vitest.config.ts`, `benchmarks/**`, `site/**`, `docs/**`, `README.md`, `CHANGELOG.md`, `examples/**`, `packages/{cli,create-celsian}/**`, all `packages/*/README.md`
`tsc -b --noEmit` · vitest typecheck enabled + test files in tsconfig · benchmark harness rigor + retract/re-run the Express claim · 3 broken site samples · README `encapsulate: false` · correct every false claim including `docs/internal/SECURITY_AUDIT.md` · examples in CI + showcase cron fix + app exports · stub package READMEs · pin CI actions to SHAs · blocking prod audit · lint warnings visible · `celsian dev` `.env` · `celsian deploy` app import · CHANGELOG sync · root version · scaffold rate-limit keyGenerator + stale security.ts comment

## Cross-track contract (CRIT-3)

The JWT realm collapse needs both sides:
- **Track 1** makes plugin-scoped `requestDecorations` resolve through the matched route's encapsulation-context chain instead of only `rootContext`.
- **Track 4** removes `scope: "app"` from `packages/jwt/src/index.ts:86` so config binds to the registering context.

Neither fix works alone. Both are specified identically in both agent prompts, and Phase 5 review verifies the pair.
