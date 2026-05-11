# CelsianJS — Next Session Pickup

## Current State
- **Branch**: `audit-hardening`
- **Tests**: 953 passed / 8 skipped (79 Vitest files) plus packed CLI/generated-app smoke coverage in `pnpm verify:publish`.
- **Release gates checked this pass**: `pnpm test`, `pnpm build`, `pnpm typecheck`, `pnpm lint:ci`, `pnpm verify:publish`, and `pnpm audit:release` all refreshed after the latest handoff cleanup.
- **Audit policy**: release/CI audit now uses production dependency scope (`pnpm audit --prod --audit-level=moderate`) so private example dev tooling such as `examples/cloudflare-worker` Wrangler is not a release blocker.

## What Was Done
- Node `serve()` / `app.listen()` now resolves only after the server is actually listening, rejects on pre-listen bind errors such as `EADDRINUSE`, and reports the actual bound port for `port: 0` through `onReady` and the returned handle.
- Added listen lifecycle regression coverage for occupied ports and successful ephemeral-port binds.
- Kept prior hardening work in place: CORS `Vary: Origin`, real HTTP smoke coverage, compression documentation cleanup, serializer JSDoc, range request support, and Brotli compression support.
- Fixed Biome lint errors by formatting affected files and organizing exports. `pnpm lint` still reports warnings (mostly existing `any` / non-null assertions), but exits successfully.
- Added `audit:release` and aligned CI security audit with production dependencies instead of forcing risky Wrangler internals or raising the repo Node engine above `>=20`.


## 2026-05-10 — Current test/publish gate refresh

Refreshed the local Celsian evidence after handoff cleanup to remove stale top-level test counts.

Verification:
- `npx -y pnpm@9.15.0 test` passed: 79 files, 953 passed / 8 skipped.
- `npx -y pnpm@9.15.0 typecheck` passed with `tsc -b --noEmit --pretty false`.
- `npx -y pnpm@9.15.0 verify:publish` passed: private/public metadata assertions, 17 packed artifacts, clean consumer install/import, and generated app build smoke.
- `npx -y pnpm@9.15.0 build` passed.
- `npx -y pnpm@9.15.0 lint:ci` passed with 181 known warnings and no errors.
- `npx -y pnpm@9.15.0 audit:release` passed with no known production vulnerabilities.

## What Remains

### Should Fix (from PM reviews)
- None currently local/reproducible. The previous response/request schema pre-compilation item is implemented: response serializers and request validators are compiled at route registration and covered in `packages/core/test/serializer.test.ts`.

### Nice to Have
- Benchmark suite expansion / stabilization.
- OpenAPI spec tests that verify generated specs match actual route behavior.
- Stress/load test for the radix-tree router under high concurrency.
- Keep the private Cloudflare Worker example audit policy documented if Wrangler/Node requirements change again; current Wrangler 4 example tooling is not reporting audit advisories locally.

## How to Resume
```bash
cd celsian
pnpm test
pnpm build
pnpm typecheck
pnpm lint
pnpm verify:publish
pnpm audit:release
```

## Release Gate Notes (2026-05-10)
- Current full and production audits pass locally with pnpm 9.15.0: `pnpm audit --audit-level=moderate` and `pnpm audit --prod --audit-level=moderate` both report no known vulnerabilities.
- Release/CI publish blocking still uses `pnpm audit:release` / production dependency scope so private example dev tooling cannot force risky runtime or Node-engine changes without an explicit policy decision.

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

## 2026-05-10 — README install accuracy follow-up

Fresh product-review found that the manual install path showed `@celsian/core` while the middleware example used first-party packages from separate package names. Addressed locally:

- README now distinguishes the core router/runtime install from first-party battery packages.
- Middleware example explicitly installs/imports `@celsian/rate-limit`, `@celsian/jwt`, and `@celsian/compress`.
- Top-level positioning now says first-party batteries instead of implying every plugin exports from core.

Verification:
- `git diff --check`

## 2026-05-10 — Scaffold install determinism follow-up

Fresh PM/gold-standard re-review found two local trust gaps: `create-celsian` templates still floated generated dependencies to `latest`, and local release verification was easy to run with a stale global pnpm. Addressed locally:

- `create-celsian` basic/full/REST/RPC templates now pin generated Celsian package ranges to the current `^0.3.6` release line instead of `latest`.
- README now calls out the repo-pinned `pnpm@9.15.0` workflow and recommends `npm run setup:pnpm` or `npx -y pnpm@9.15.0 ...` when Corepack/global pnpm is stale.

Verification:
- `npx -y pnpm@9.15.0 exec vitest run packages/create-celsian/test/scaffolder.test.ts` → 14 tests passed
- `npx -y pnpm@9.15.0 --filter create-celsian build` passed
- `git diff --check` passed

## 2026-05-10 — Registry smoke release follow-up

Gold-standard re-review found that release automation had strong pre-publish tarball smoke but only manual post-publish `npm view` checks. Addressed locally:

- Added `scripts/verify-registry-install.mjs` and `pnpm verify:registry` to install the published Celsian package set into a clean temp consumer, import public packages, verify installed CLI binaries, run a `create-celsian` scaffold smoke, and write `artifacts/registry-smoke.json`.
- Release workflow now runs the registry smoke after Changesets actually publishes and uploads the smoke artifact with `if-no-files-found: error`.
- README deployment wording now distinguishes adapter/runtime support from unqualified live-provider claims.

Verification:
- `npx -y pnpm@9.15.0 verify:publish` passed: 17 packed package artifacts, clean consumer install/import smoke
- `node --check scripts/verify-registry-install.mjs` passed
- `git diff --check` passed

Not run:
- `pnpm verify:registry` is post-publish only and needs freshly published npm versions to prove the real registry path.

## 2026-05-10 — PR CI package-smoke follow-up

Gold-standard re-review found the release workflow ran publish-artifact smoke, but PR CI did not. Addressed locally:

- `.github/workflows/test.yml` now has read-only permissions and concurrency cancellation.
- Added a PR CI `package-smoke` job that builds and runs `pnpm verify:publish` so packed-package consumer smoke is exercised before release.

Verification:
- `npx -y pnpm@9.15.0 verify:publish` passed: 17 packed package artifacts, clean consumer install/import smoke
- `git diff --check` passed

## 2026-05-10 — WhatStack runbook smoke refresh

Ran the Celsian core smoke from `../SMOKE-TEST-RUNBOOK.md` against the built local package:

- `node -e "...createApp(); serve(app, { port: 9999 })..."` returned `200` for `/health` and `/hello/kirby`.
- The missing-route smoke returned `404` with security headers including `x-content-type-options: nosniff` and `x-frame-options: DENY`.

## 2026-05-10 — Env example tracking follow-up

Gold-standard recheck found the safe root `.env.example` was present locally but ignored by `.gitignore` because `.env.*` had no exception. Addressed locally:

- Added `!.env.example` so adapter credential placeholders are committed without weakening real `.env*` secret ignores.
- Added the placeholder-only `.env.example` file to the repo.

Verification:
- `git diff --check` passed.
- `.env.example` contains empty placeholder values only.
