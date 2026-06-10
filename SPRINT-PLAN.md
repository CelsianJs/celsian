# Sprint Plan — CelsianJS 0.5.2 Hardening
Generated: 2026-06-09
Based on: WhatStack/CELSIAN-TRIPLE-AUDIT-2026-06-09.md (smoke C+/B−, gold 39/50, product 7/10)

## Sprint Goal
Ship a 0.5.2 where the serverless+hot-server promise is true **without asterisks** and a new user's first 10 minutes contain zero crashes: fix both CRITICALs, all code HIGHs, the doc samples that crash as written, and the release-trust gaps.

## Success Criteria
- [ ] Both CRITICALs fixed (host binding, `celsian routes`)
- [ ] Lambda cookie + binary fidelity fixed; WS runtime honesty enforced
- [ ] Rate-limit XFF bypass fixed
- [ ] Every documented code sample runs as written
- [ ] Scaffold templates work first-try (rest-api validation, CSRF vs RPC, first POST)
- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green
- [ ] Changesets added for every published-package change (patch bumps → 0.5.2)

## Dev Tracks (worktrees under /tmp/celsian-sprint/, branches sprint/0.5.2-*)

### Track 1: core — packages/core + packages/celsian umbrella
- CORE-01 (P0): Host binding — `config.ts` default host `0.0.0.0` when NODE_ENV=production (keep `localhost` in dev), honor `process.env.HOST`, log the actually-bound address in serve.ts
- CORE-02 (P1): CSRF `excludePaths` prefix matching (`plugins/csrf.ts`)
- CORE-03 (P1): `_routeWithSchema` must use `opts.handler`; throw at registration if missing (`app.ts`)
- CORE-04 (P1): Serverless-safety warnings (enqueue-without-worker, cron-without-scheduler) emit via console.warn even with noop logger (`app.ts`)
- CORE-05 (P1): CORS adds `Vary: Origin` whenever allowed origin ≠ literal `*` (`plugins/cors.ts`)
- CORE-06 (P1): Pass/enforce bodyLimit for custom content-type parsers (`body-parser.ts`)
- CORE-07 (P1): WS — console.warn when `ws` import fails on Node; warn when `app.ws()` routes exist under serveBun/serveDeno (no upgrade wiring) (`serve.ts`, `websocket.ts`)
- CORE-08 (P2): `serve()` resolves only after listen callback; `onReady` reports OS-assigned port (port:0) (`serve.ts`)
- CORE-09 (P2): `reply.send(Uint8Array|ArrayBuffer)` sends bytes with application/octet-stream, not JSON.stringify (`reply.ts`)
- CORE-10 (P2): Cron tick dedupe — guard against double-fire within same boundary minute (`cron.ts`)
- CORE-11 (P2): Node serve: explicit `server.requestTimeout`/`headersTimeout` (`serve.ts` / adapter helpers in core)
- CORE-12 (P2): Umbrella `packages/celsian/src/index.ts`: re-export core plugins missing (csrf, etag, analytics exports) — only what umbrella's deps already cover
- CORE-13: Tests for every fix above

### Track 2: adapters — packages/adapter-lambda, adapter-vercel, adapter-cloudflare, adapter-bun (README only)
- ADP-01 (P0): Lambda reads `event.cookies` (APIGW v2) into the Request cookie header
- ADP-02 (P0): Lambda binary bodies stay bytes (Buffer → BodyInit), never `.toString('utf-8')`
- ADP-03 (P1): Lambda v1 (REST API) + ALB event support (detect shape; map method/path/headers/query/body)
- ADP-04 (P1): adapter-vercel: move `node:crypto` import into lazy/dynamic import inside cron handler so `createVercelEdgeHandler` bundles on platform=neutral
- ADP-05 (P1): adapter-cloudflare: export a `createScheduledHandler(app)` (or include `scheduled` in handler object) bridging CF Cron Triggers to app.cron jobs
- ADP-06 (P2): adapter-bun README: document that WS upgrades bypass route hooks (auth must be done in ws open handler)
- ADP-07: Tests (realistic APIGW v1/v2/ALB events incl. cookies + binary; vercel edge import without node builtins; CF scheduled)

### Track 3: secpkgs — packages/rate-limit, packages/rpc, packages/jwt
- SEC-01 (P0): rate-limit: key strategy rightmost-untrusted XFF (`trustedProxyHops` option, default 1), never leftmost; cap distinct keys in MemoryRateLimitStore (LRU/max-keys)
- SEC-02 (P1): rate-limit: invalid/NaN `window` throws at registration (fail closed, like the trustProxy guard)
- SEC-03 (P1): rpc: sanitize non-HttpError messages in production (mirror core error-handler)
- SEC-04 (P1): rpc README: fix `app.all` sample → `app.get` + `app.post`
- SEC-05 (P2): jwt: console.warn when secret < 32 bytes
- SEC-06: Tests for all

### Track 4: cli — packages/cli, packages/create-celsian
- CLI-01 (P0): `routes` command: replace tsx --eval CJS loader with temp .mts module (fix top-level-await crash); surface real loader errors
- CLI-02 (P1): `celsian create` delegates to create-celsian templates (shared code or spawn) — same templates, current version; no more 0.3.18 pin
- CLI-03 (P1): create-celsian: refuse non-empty target dir without `--force`
- CLI-04 (P1): rest-api template: fix `format: 'email'` (pattern or format registration)
- CLI-05 (P1): full template: CSRF excludePaths covers `/_rpc/*` (works with CORE-02 prefix matching; template should also work standalone)
- CLI-06 (P1): templates: add .gitignore + README to basic/rest-api/rpc-api; validate project name (npm name rules)
- CLI-07 (P1): full template: load `.env` (dev script `node --env-file=.env` / tsx equivalent) or remove the cp instruction; document CSRF flow + add token-minting recipe (dev `/auth/token` route or README curl recipe)
- CLI-08 (P2): deploy command: generated wrangler.toml includes `nodejs_compat` + current compatibility_date; auto-add adapter dep to package.json (or print exact install command); fix `--target` vs `--platform` header comment
- CLI-09: Tests (scaffold each template to tmp, install workspace deps where feasible, assert files + tsc clean; routes command integration test)

### Track 5: docs — README.md, docs/*, SECURITY.md, LICENSE, CHANGELOG.md, site/index.html, per-pkg stub READMEs, root cleanup
- DOC-01 (P1): ESM requirement callout (README Quick Start + quickstart.md manual setup: `"type": "module"`)
- DOC-02 (P1): Fix ALL rate-limit samples (add `trustProxy: true` + note) — README, docs/plugins.md, docs/hooks.md
- DOC-03 (P1): plugins.md scoped-registration table: correct rate-limit guidance (`encapsulate: false`)
- DOC-04 (P1): migration-from-fastify.md: fix 5 errors (createLambdaHandler/createVercelHandler names; preParsing/preValidation/preSerialization exist; inject() returns Web Response — status + await json(); `reply.status(422).json(...)` not second-arg; `req.parsedBody` not `request.body`)
- DOC-05 (P1): SECURITY.md: GitHub private vulnerability reporting (no dead email), supported versions 0.5.x
- DOC-06 (P1): README: contributing snippet `pnpm build` before `pnpm test`; examples/saas-demo bootstrap note (root pnpm install)
- DOC-07 (P1): README: single consistent benchmark section (one claim + matching table), adapter table lists all 8, document `ws` dependency for WebSockets, CSRF mention near scaffold first-POST
- DOC-08 (P2): LICENSE © CelsianJS; site/index.html footer version → 0.5.x; per-package stub READMEs (adapters, queue-redis, ws-redis, create-celsian) get a usage example each
- DOC-09 (P2): Relocate internal dev markdown (AUDIT-2026-06-07.md, NEXT-SESSION.md, QA-REPORT.md, PRODUCT-REVIEW.md, RELEASE-PLAN.md, MILESTONES.md, FEATURE_PARITY.md, PERFORMANCE-ROADMAP.md, SECURITY_AUDIT.md, realism-audit/, qa-test-app.ts) → docs/internal/ (git mv); root keeps README/CHANGELOG/CONTRIBUTING/SECURITY/LICENSE/SPRINT-PLAN.md
- DOC-10 (P2): CHANGELOG.md: add 0.5.1 entry; brief backfill stubs for 0.3.x/0.4.0 pointing at GitHub releases
- DOC-11 (P2): docs/errors.md: map error `code` strings (HttpError codes) to cause + fix

### Track 6: infra — .github/workflows, root package.json, biome/husky/vscode, benchmarks deps
- INF-01 (P1): release.yml: `NPM_CONFIG_PROVENANCE: true` env on publish step
- INF-02 (P1): test.yml: `concurrency: cancel-in-progress`; add test-bun + test-deno to `ci-passed` needs (fix the 1-2 Bun stack-trace test diffs or scope Bun job to passing suites — must be blocking and green)
- INF-03 (P1): workerd smoke job: minimal worker built from adapter-cloudflare run via `wrangler dev --local` or miniflare/vitest-pool-workers, curl assert
- INF-04 (P2): size-limit: root devDep + `.size-limit.json` for @celsian/core + adapters, CI step
- INF-05 (P2): husky + lint-staged (`biome check --write` staged), `.vscode/extensions.json` (Biome)
- INF-06 (P2): bump benchmarks workspace deps (express/fastify/autocannon) to clear `pnpm audit --prod`
- INF-07 (P2): root package.json: align private root version note (0.3.18 → 0.5.2) — cosmetic

## Intentionally Skipped (this sprint)
- WS upgrades through hook lifecycle on all adapters (architectural; needs design)
- Lambda response streaming; tRPC-style RPC codegen CLI
- Marketing-site deploy + whatfw.com cross-link (needs domain/Vercel decisions)
- npm OIDC trusted publishing (npm org settings — manual)
- Deleting packages/platform + edge-router (Kirby decision — they're private/unpublished)

## Manual Actions for Kirby (outward-facing, not done by sprint)
1. Merge PR #36 (or close it in favor of the sprint branch PR) and push tags / create 0.5.1+0.5.2 GitHub releases
2. `gh repo edit` description: fix "590 tests" → 1400+
3. npm publish 0.5.2 through CI (after merge), verify provenance attestations appear
4. Decide fate of deprecated adapter-bun/deno 1.0.0 publishes (unpublish window?)
5. Set up npm OIDC trusted publishing; site deployment + ecosystem cross-links
