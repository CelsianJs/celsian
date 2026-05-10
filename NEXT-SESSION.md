# CelsianJS — Next Session Pickup

## Current State
- **Branch**: `audit-hardening`
- **Tests**: 925 passing, 7 skipped (77 Vitest files) plus release smoke coverage in `test/smoke.test.ts`.
- **Release gates checked this pass**: `pnpm test`, `pnpm build`, `pnpm exec tsc --noEmit --pretty false`, `pnpm lint`, `pnpm verify:publish`, and `pnpm audit:release` all complete successfully.
- **Audit policy**: release/CI audit now uses production dependency scope (`pnpm audit --prod --audit-level=moderate`) so private example dev tooling such as `examples/cloudflare-worker` Wrangler is not a release blocker.

## What Was Done
- Node `serve()` / `app.listen()` now resolves only after the server is actually listening, rejects on pre-listen bind errors such as `EADDRINUSE`, and reports the actual bound port for `port: 0` through `onReady` and the returned handle.
- Added listen lifecycle regression coverage for occupied ports and successful ephemeral-port binds.
- Kept prior hardening work in place: CORS `Vary: Origin`, real HTTP smoke coverage, compression documentation cleanup, serializer JSDoc, range request support, and Brotli compression support.
- Fixed Biome lint errors by formatting affected files and organizing exports. `pnpm lint` still reports warnings (mostly existing `any` / non-null assertions), but exits successfully.
- Added `audit:release` and aligned CI security audit with production dependencies instead of forcing risky Wrangler internals or raising the repo Node engine above `>=20`.

## What Remains

### Should Fix (from PM reviews)
- Response schema pre-compilation: schemas get re-compiled on every request. Consider caching compiled validators at route registration time.

### Nice to Have
- Benchmark suite expansion / stabilization.
- OpenAPI spec tests that verify generated specs match actual route behavior.
- Stress/load test for the radix-tree router under high concurrency.
- Decide long-term policy for the private Cloudflare Worker example: keep Wrangler 3 on Node 20 and out of release audit, or move that example to Wrangler 4 with a documented Node 22+ requirement for the example only.

## How to Resume
```bash
cd celsian
pnpm test
pnpm build
pnpm exec tsc --noEmit --pretty false
pnpm lint
pnpm verify:publish
pnpm audit:release
```

## Release Gate Notes (2026-05-10)
- `pnpm audit --audit-level=moderate` still reports advisories through private example dev tooling (`examples/cloudflare-worker > wrangler@3.114.17` via `undici@5.29.0` and `esbuild@0.17.19`).
- This is intentionally not force-overridden: Wrangler 4 requires Node 22+, while the repo still advertises Node `>=20`.
- Use `pnpm audit:release` / CI production audit for publish blocking until the example's Node/Wrangler policy is changed explicitly.

## 2026-05-10 — Adapter Release Gate Follow-up

Product-review recheck after public publish found no P0s, but did find Celsian deployment adapter and release gate P1s. Addressed:

- Fly adapter now threads the compiler-provided `serverEntry` into the generated Dockerfile `CMD` instead of hardcoding `dist/server/entry.js`.
- Railway adapter now threads `serverEntry` into `Procfile`, `railway.json.deploy.startCommand`, and optional Dockerfile `CMD`.
- Added adapter tests for non-default `dist/index.js` server entries.
- Release workflow now runs build, typecheck, lint, test, production audit, and workspace-reference artifact verification before Changesets publish.
- Quickstart Node prerequisite now matches package engines (`Node.js 20+`).

Verification run with pnpm 9.15.0 via `npx -y pnpm@9.15.0` because global pnpm is 8.11.0 and Corepack is currently failing signature-key verification locally:

- Adapter focused tests: 8 passed
- `pnpm build` passed
- `pnpm test` passed: 77 files, 927 tests passed, 7 skipped
- `pnpm audit:release` passed: 0 known prod vulnerabilities
- `bash scripts/verify-publish.sh` passed: 17 package artifacts checked, no unresolved `workspace:` refs
- `git diff --check` passed

Remaining non-blocking review items:

- Existing `pnpm lint` emits pre-existing warnings across examples/tests; release workflow runs it, but the repo's Biome configuration treats these as warnings rather than release-blocking errors.
- Private platform packages/docs still need clearer wording if/when those packages become public-facing.

## 2026-05-10 — Adapter Patch Release

Published follow-up public OSS adapter patch after adapter release hardening:

- `@celsian/adapter-fly@0.3.3`
- `@celsian/adapter-railway@0.3.3`

Pre-publish verification:

- `npx -y pnpm@9.15.0 build`
- `npx -y pnpm@9.15.0 test` → 77 files, 927 tests passed, 7 skipped
- `npx -y pnpm@9.15.0 audit:release` → 0 known prod vulnerabilities
- `bash scripts/verify-publish.sh` → 17 package artifacts checked
- filtered publish dry-run for both adapter packages passed

Post-publish verification:

- `npm view @celsian/adapter-fly@0.3.3 version` → `0.3.3`
- `npm view @celsian/adapter-railway@0.3.3 version` → `0.3.3`
