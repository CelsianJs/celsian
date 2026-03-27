# Sprint Plan — CelsianJS Hardening

Generated: 2026-03-27
Based on: Critical product review (4 research agents — codebase, security, competitive, engineering)

## Sprint Goal

Fix all security vulnerabilities, eliminate @celsian/server duplication, resolve all 13 QA bugs, reduce memory footprint, and raise the product score from 3.5/10 to 7+/10.

## Success Criteria

- [ ] All 4 CRITICAL security issues resolved
- [ ] All 7 HIGH security issues resolved
- [ ] All 13 QA-reported bugs fixed
- [ ] @celsian/server eliminated (consolidated into @celsian/core)
- [ ] Memory RSS reduced from 94MB toward <50MB
- [ ] Silent error swallowing replaced with logging
- [ ] All tests pass (806+ tests, 0 failures, 0 errors)
- [ ] No hardcoded secrets in examples

## Dev Tracks

### Track 1: Security Hardening — Dev Agent 1

**Scope:** Fix all CRITICAL + HIGH security vulnerabilities across the codebase.

**Files touched:**
- `packages/adapter-node/src/index.ts` (path traversal)
- `packages/core/src/serve.ts` (WebSocket origin + auth)
- `packages/core/src/hooks.ts` (async error logging)
- `packages/core/src/cron.ts` (cron error logging)
- `packages/core/src/cookie.ts` (secure defaults)
- `packages/core/src/plugins/csrf.ts` (NEW)
- `packages/rate-limit/src/index.ts` (trustProxy)
- `packages/jwt/src/index.ts` (if timing fix needed here too)
- `examples/showcase/src/index.ts` (hardcoded secrets)

**Tasks:**
- [ ] TASK-01 (P0): Fix adapter-node path traversal — add resolve() + startsWith() containment at index.ts:174
- [ ] TASK-02 (P0): Fix WebSocket origin validation + run auth hooks before upgrade at serve.ts:180-202
- [ ] TASK-03 (P0): Remove hardcoded JWT secret and SHA-256 password hash from examples/showcase/src/index.ts:82,96,110
- [ ] TASK-04 (P1): Fix rate limiter — require trustProxy for X-Forwarded-For at rate-limit/src/index.ts:61-65
- [ ] TASK-05 (P1): Create CSRF middleware plugin at core/src/plugins/csrf.ts
- [ ] TASK-06 (P1): Fix silent async error swallowing — hooks.ts:74-86, cron.ts:100-105
- [ ] TASK-07 (P1): Default cookie options to httpOnly + secure + sameSite at cookie.ts:36-51
- [ ] TASK-08: Write security regression tests for all fixes (adapter-node, WS, CSRF, rate-limit, cookies)

### Track 2: Kill @celsian/server + Fix QA Bugs — Dev Agent 2

**Scope:** Eliminate server package duplication. Migrate unique features to core. Fix all 13 QA bugs.

**Files touched:**
- `packages/server/` (entire package — DELETE after migration)
- `packages/core/src/app.ts` (bug fixes + migrated features)
- `packages/core/src/sse.ts` (NEW — migrated from server)
- `packages/core/src/router.ts` (BUG-7, BUG-8, BUG-11)
- `packages/core/src/request.ts` (BUG-13)
- `packages/core/src/plugins/cors.ts` (BUG-12)
- `packages/core/src/reply.ts` (error leakage fix)
- `packages/rpc/src/router.ts` (BUG-9)
- `packages/schema/src/adapters/typebox.ts` (BUG-2)
- `pnpm-workspace.yaml`, `tsconfig.json` (remove server refs)

**Tasks:**
- [ ] TASK-09 (P0): Fix BUG-1 — verify ESM serve() uses dynamic import (may already be fixed)
- [ ] TASK-10 (P0): Fix BUG-2 — TypeBox adapter ESM crash at schema/src/adapters/typebox.ts:13
- [ ] TASK-11 (P1): Fix BUG-3 — Multiple Set-Cookie headers lost at core/src/serve.ts:237-239
- [ ] TASK-12 (P1): Fix BUG-5/6 — onSend hook headers lost + CORS broken at core/src/app.ts:329-333
- [ ] TASK-13 (P1): Fix BUG-9 — RPC POST body consumed at rpc/src/router.ts:99
- [ ] TASK-14 (P2): Fix BUG-4 — Plugin decorate() not on app instance at core/src/app.ts:110-113
- [ ] TASK-15 (P3): Fix BUG-7/8 — 404 vs 405 + HEAD fallback at core/src/router.ts:88
- [ ] TASK-16 (P3): Fix BUG-10 — Malformed JSON returns 200 at core/src/app.ts:378-388
- [ ] TASK-17 (P3): Fix BUG-11 — Path params not URL-decoded at core/src/router.ts:129
- [ ] TASK-18 (P3): Fix BUG-12 — CORS preflight leaks at core/src/plugins/cors.ts:48-76
- [ ] TASK-19 (P3): Fix BUG-13 — Duplicate query params at core/src/request.ts:10-13
- [ ] TASK-20: Migrate SSE from server to core (core/src/sse.ts)
- [ ] TASK-21: Migrate any unique server middleware to core plugins
- [ ] TASK-22: Port security hardening from core to server (CRLF, proto pollution, body limit, error leakage) — needed BEFORE deletion so tests pass during migration
- [ ] TASK-23: Remove @celsian/server package — delete directory, update workspace/tsconfig
- [ ] TASK-24: Write regression tests for all 13 bug fixes

### Track 3: Memory + Build + Docs — Dev Agent 3

**Scope:** Memory optimization, build system fixes, documentation updates, flaky tests.

**Files touched:**
- `packages/core/src/request.ts` (allocation optimization)
- `packages/core/src/app.ts` (request lifecycle optimization)
- `packages/core/src/task.ts` (MemoryQueue eviction)
- `tsconfig.json` (missing package refs)
- `packages/cache/test/bench.test.ts` (flaky test)
- `examples/crud-api/test/api.test.ts` (EADDRINUSE)
- `README.md`, `SECURITY_AUDIT.md`, `QA-REPORT.md`
- All `packages/*/package.json` (version bump to 0.2.0)

**Tasks:**
- [ ] TASK-25: Add MemoryQueue job eviction at core/src/task.ts (max 1000 completed jobs)
- [ ] TASK-26: Optimize per-request allocations — frozen empty query, lazy init, reduce closures
- [ ] TASK-27: Add missing packages to tsconfig.json references (9 packages missing)
- [ ] TASK-28: Fix EADDRINUSE in examples/crud-api/test/api.test.ts (proper teardown)
- [ ] TASK-29: Fix flaky bench test at packages/cache/test/bench.test.ts:242 (timing threshold)
- [ ] TASK-30: Update README.md — remove @celsian/server refs, add CSRF plugin, update security status
- [ ] TASK-31: Update SECURITY_AUDIT.md — mark all new fixes
- [ ] TASK-32: Update QA-REPORT.md — mark all 13 bugs RESOLVED
- [ ] TASK-33: Bump all packages to 0.2.0
- [ ] TASK-34: Run full test suite — target 0 failures, 0 errors, 0 flaky

## File Conflict Analysis

| File | Track 1 | Track 2 | Track 3 | Conflict? |
|------|---------|---------|---------|-----------|
| adapter-node/src/index.ts | YES | no | no | None |
| core/src/serve.ts | YES (WS) | no | no | None |
| core/src/hooks.ts | YES | no | no | None |
| core/src/cron.ts | YES | no | no | None |
| core/src/cookie.ts | YES | no | no | None |
| core/src/app.ts | no | YES (bugs) | no | None |
| core/src/router.ts | no | YES (bugs) | no | None |
| core/src/request.ts | no | YES (BUG-13) | YES (alloc) | MINOR — Track 3 touches different lines |
| core/src/task.ts | no | no | YES | None |
| rate-limit/src/index.ts | YES | no | no | None |
| server/* | no | YES (delete) | no | None |
| tsconfig.json | no | no | YES | None |
| README.md | no | no | YES | None |

**One minor overlap** on core/src/request.ts — Track 2 fixes BUG-13 (duplicate query params), Track 3 optimizes allocations. These touch different code sections so merge should be clean.

## Intentionally Skipping

- **Route-string type inference** (competitive gap vs Hono/Elysia) — requires major architecture change, not a bug fix. Separate initiative.
- **`@celsian/api` empty package** — just delete it during Track 2 cleanup. Trivial.
- **Template engine support** — feature request, not a quality issue.
- **The `server/src/tasks.ts` silent error catch** — gets deleted with @celsian/server.

## Task Summary

| Priority | Count | Tracks |
|----------|-------|--------|
| P0 (CRITICAL) | 4 | Track 1: 3, Track 2: 1 |
| P1 (HIGH) | 8 | Track 1: 4, Track 2: 4 |
| P2 (MEDIUM) | 1 | Track 2: 1 |
| P3 (LOW) | 5 | Track 2: 5 |
| Infrastructure | 16 | Track 1: 1, Track 2: 5, Track 3: 10 |
| **Total** | **34** | |
