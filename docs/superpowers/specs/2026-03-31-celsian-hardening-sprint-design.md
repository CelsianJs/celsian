# CelsianJS v0.3.0 Hardening Sprint

**Date**: 2026-03-31
**Scope**: Full push — security, engineering, DX (type inference), positioning (landing page + demo)
**Source**: PRODUCT-REVIEW.md (5-agent audit, 2026-03-30)
**Target**: v0.3.0 release

---

## Sprint Architecture

5 agents, 3 phases, ~55 tasks.

```
PM Agent (orchestrator)
├── Phase 1: Security + Engineering + DX (3 parallel dev agents in worktrees)
│   ├── Dev1: Security hardening (9 tasks)
│   ├── Dev2: Engineering gaps (8 tasks)
│   ├── Dev3: parsedBody type inference (8 tasks)
│   └── Review Agent: post-merge audit
│
├── Phase 2: Polish + Positioning (3 parallel dev agents in worktrees)
│   ├── Dev1: JSDoc + benchmarks + README (6 tasks)
│   ├── Dev2: Landing page deploy + SaaS demo (4 tasks)
│   ├── Dev3: Scaffolder improvements + cleanup (6 tasks)
│   └── Review Agent: post-merge audit
│
└── Phase 3: Ship
    ├── PM: Version bump, changelog, final test run
    └── Review Agent: final pass
```

**Merge strategy**: Each phase produces isolated worktree branches. PM merges all 3 into `main` before the review agent runs. Review agent blocks the next phase until all issues are resolved.

---

## Phase 1: Security + Engineering + DX

### Dev1 — Security Hardening

All tasks address findings from the security audit. Each fix must include a corresponding test.

**S1. Fix CORS+credentials default in scaffolder (HIGH)**
- File: `packages/create-celsian/src/templates/full.ts:191-195`
- Change: Replace `CORS_ORIGIN` default from `*` to `http://localhost:3000` in `.env.example`
- Also: Add a comment in the generated code warning about `credentials: true` with wildcard origins
- Test: Verify generated `.env.example` has `CORS_ORIGIN=http://localhost:3000`

**S2. Refuse default JWT secret in production (MEDIUM)**
- File: `packages/create-celsian/src/templates/full.ts:157`
- Change: In the generated `auth.ts`, add a startup check: if `NODE_ENV === 'production'` and the secret matches `dev-secret-change-me`, throw `Error('JWT_SECRET must be set in production. See .env.example')`
- Test: Verify the generated code contains the production guard

**S3. HTML-escape Swagger UI interpolations (MEDIUM)**
- File: `packages/core/src/plugins/openapi.ts:236-261`
- Change: Create a `escapeHtml(str)` helper that escapes `<`, `>`, `"`, `'`, `&`. Apply to `title` and `jsonPath` in the `swaggerHTML()` template
- Test: Pass a title containing `<script>alert(1)</script>` and verify the output HTML has escaped entities

**S4. Remove RegExp deserialization from RPC wire (MEDIUM)**
- File: `packages/rpc/src/wire.ts:77-88`
- Change: Remove the `case 'RegExp'` branch from `decode()`. Replace with returning the pattern as a plain string (or throwing). Update `encode()` to serialize RegExp as `{ __type: 'String', value: pattern }` for backwards compat
- Test: Verify that encoding a RegExp and decoding produces a string, not a RegExp object. Verify no ReDoS is possible.

**S5. Fix stack trace leak when NODE_ENV unset (MEDIUM)**
- File: `packages/core/src/errors.ts:3-5`
- Change: Invert the default — `isDev` should be `process.env.NODE_ENV === 'development'` (explicit opt-in to dev mode, not opt-out of production)
- Test: With no `NODE_ENV` set, verify error responses do NOT include stack traces. With `NODE_ENV=development`, verify they DO.

**S6. Add security to all scaffolder templates (MEDIUM)**
- Files: `packages/create-celsian/src/templates/basic.ts`, `rest-api.ts`, `rpc-api.ts`
- Change: Add `import { cors } from '@celsian/core/plugins/cors'` and `import { security } from '@celsian/core/plugins/security'` to each template. Register them with `app.register(cors())` and `app.register(security(), { encapsulate: false })`
- Test: Generate each template and verify the output includes CORS and security header imports/registration

**S7. Fix rate limiter default key generator (LOW)**
- File: `packages/rate-limit/src/index.ts:74-77`
- Change: When `trustProxy` is false and no custom `keyGenerator` is provided, log a one-time warning: `'[celsian] rate-limit: no client IP available and no custom keyGenerator provided. Rate limiting is effectively disabled. Set trustProxy: true or provide a keyGenerator.'`. Keep the current behavior (unique key per request) but make the no-op visible.
- Test: Verify the warning is logged when using defaults

**S8. Add root directory parameter to sendFile (LOW)**
- File: `packages/core/src/reply.ts:163-165`
- Change: Add optional `root` parameter to `sendFile(filePath, root?)`. When provided, resolve `filePath` relative to `root` and verify the resolved path starts with `root` (same pattern as static file serving). When not provided, current behavior.
- Test: Verify that `sendFile('../../../etc/passwd', '/app/static')` returns 403. Verify normal usage still works.

**S9. Write tests for all security fixes**
- Create `packages/core/test/security-hardening.test.ts` covering S3, S5, S7, S8
- Create `packages/rpc/test/wire-security.test.ts` covering S4
- Scaffolder tests (S1, S2, S6) go in `packages/create-celsian/test/security.test.ts`

---

### Dev2 — Engineering Gaps

Infrastructure and testing improvements with no overlap with security or type system work.

**E1. Add engines field to all packages**
- Files: All 19 `packages/*/package.json` + root `package.json`
- Change: Add `"engines": { "node": ">=20" }` to every package.json
- Verification: `grep -rL '"engines"' packages/*/package.json` returns empty

**E2. Write CLI tests**
- File: `packages/cli/test/` (new directory)
- Coverage: Test `dev` command (spawns tsx with watch), `build` command (esbuild output), `generate route` (creates file with correct content), `generate rpc` (creates file), `routes` (prints registered routes)
- Approach: Unit test the command logic, not the full CLI process. Mock filesystem for generate commands.
- Target: At least 1 test per command (5 tests minimum)

**E3. Write scaffolder tests**
- File: `packages/create-celsian/test/` (new directory)
- Coverage: Each template generates valid TypeScript, flag parsing works (`--template`, `--pkg-manager`), package manager detection from `npm_config_user_agent`, output directory structure matches expectations
- Approach: Generate to a temp directory, verify file contents
- Target: At least 1 test per template (4 tests) + 2 for flag parsing

**E4. Write adapter-fly and adapter-railway tests**
- Files: `packages/adapter-fly/test/adapter.test.ts`, `packages/adapter-railway/test/adapter.test.ts`
- Coverage: Verify each adapter exports the expected functions, generates correct config files (fly.toml, railway.json, Procfile, Dockerfile)
- Target: 2-3 tests per adapter

**E5. Mark platform package as private**
- File: `packages/platform/package.json`
- Change: Add `"private": true` to prevent publishing pure stubs to npm
- Also: Add a comment at the top of each stub file: `// Not yet implemented — see MILESTONES.md`

**E6. Add typecheck to CI**
- File: `.github/workflows/test.yml`
- Change: Add a step after build: `- name: Typecheck\n  run: pnpm typecheck`
- Verify: The `typecheck` script exists in root package.json (it does: `tsc -b --noEmit`)

**E7. Verify workspace:* resolves on publish**
- File: `.github/workflows/release.yml` or new `scripts/verify-publish.js`
- Change: Before the publish step, run `pnpm pack` on `@celsian/core` and inspect the tarball's package.json for `workspace:*` strings. Fail the build if found.
- Approach: Simple script that extracts the tarball and greps for `workspace:`

**E8. Add engines to root package.json**
- File: Root `package.json`
- Change: Add `"engines": { "node": ">=20", "pnpm": ">=9" }`

---

### Dev3 — parsedBody Type Inference

The most architecturally significant change. Wires schema types through to handler parameters so developers never need `as` casts.

**Design approach**: Add an overloaded route method signature that accepts a schema options object as the second parameter. When schema is provided, the handler's `req` object gets typed `parsedBody`, `parsedQuery`, etc.

```typescript
// Before (0.2.0 — requires cast):
app.post('/users', async (req, reply) => {
  const body = req.parsedBody as { name: string; email: string };
});

// After (0.3.0 — fully typed):
app.post('/users', {
  schema: { body: z.object({ name: z.string(), email: z.string() }) }
}, async (req, reply) => {
  req.parsedBody.name; // string — no cast needed
});
```

**T1. Define InferSchema utility types**
- File: `packages/schema/src/types.ts`
- Add: `type InferOutput<T>` that extracts the output type from a Zod schema (`.parse` return type), TypeBox schema (`Static<T>`), or Valibot schema. Use conditional types to detect which library the schema is from.
- This must work at the type level only — no runtime changes to `@celsian/schema`.

**T2. Define typed route options interface**
- File: `packages/core/src/types.ts`
- Add: `interface RouteSchemaOptions<TBody, TQuery, TParams>` with optional `body`, `querystring`, `params` fields
- Add: `interface TypedRequest<TBody, TQuery, TParams>` extending `CelsianRequest` with typed `parsedBody: TBody`, `parsedQuery: TQuery`, `params: TParams`

**T3. Add overloaded route method signatures**
- File: `packages/core/src/app.ts`
- Change: Add overload for `app.get`, `app.post`, etc. that accepts `(path, schemaOpts, handler)` where handler receives `TypedRequest`. Keep the existing `(path, handler)` signature for backwards compat.
- The schema options object also accepts existing route options (`onRequest`, `preHandler`, etc.)

**T4. Wire schema inference through addRoute**
- File: `packages/core/src/app.ts`
- Change: When `addRoute` receives a schema options object, store the schemas on the internal route definition (this already happens for validation). The type change is purely at the TypeScript level — the runtime behavior of schema validation is unchanged.

**T5. Add typed query inference**
- File: `packages/core/src/types.ts`
- When `schema.querystring` is provided, `req.parsedQuery` should be typed with the schema's output type instead of `Record<string, string | string[]>`.

**T6. Update RPC to use same inference**
- Files: `packages/rpc/src/procedure.ts`, `packages/rpc/src/types.ts`
- The RPC package already has `.input()` and `.output()` on procedures. Verify the inference chains through to the procedure handler. If it doesn't (e.g., handler receives `unknown`), wire it the same way.

**T7. Write type-level tests**
- File: `packages/core/test/type-inference.test.ts` (new)
- Use `expectTypeOf` from vitest to verify:
  - `parsedBody` is typed when body schema provided
  - `parsedBody` is `unknown` when no schema
  - `parsedQuery` is typed when querystring schema provided
  - `params` stays typed via `ExtractRouteParams` (already works)
  - Works with Zod, TypeBox, and Valibot schemas
- Target: 10+ type assertions

**T8. Update all examples and templates**
- Files: All `examples/*/src/index.ts`, all `packages/create-celsian/src/templates/*.ts`
- Change: Replace all `req.parsedBody as { ... }` casts with the new schema options API
- Remove all `(req as any).user` patterns — use proper `decorateRequest` type augmentation instead
- Verify no `as` casts remain in any example or template

---

## Phase 1 Review Agent

After PM merges all 3 worktree branches into main:

1. `pnpm install && pnpm build` — must succeed
2. `pnpm test` — all tests pass (709 existing + new tests)
3. `pnpm typecheck` — zero errors
4. `pnpm lint` — zero errors (warnings OK)
5. Grep for `as {` and `as any` in `examples/` and `create-celsian/src/templates/` — must be zero
6. Grep for `workspace:` in `packages/*/package.json` `dependencies` — must be resolved
7. Spot-check each security fix:
   - S1: `.env.example` has `CORS_ORIGIN=http://localhost:3000`
   - S3: OpenAPI HTML escapes `<script>` in title
   - S4: RPC wire decode does not produce RegExp
   - S5: No stack trace in error response without NODE_ENV
8. Verify type inference works: create a temp file importing `@celsian/core`, define a route with Zod body schema, confirm IDE shows typed `parsedBody`
9. Report all findings. Block Phase 2 until resolved.

---

## Phase 2: Polish + Positioning

### Dev1 — JSDoc + Benchmarks + README

**P1. JSDoc on core public exports**
- Files: `packages/core/src/app.ts`, `reply.ts`, `request.ts`, `hooks.ts`, `errors.ts`, `serve.ts`, `cron.ts`, `task.ts`, `websocket.ts`, `sse.ts`
- Coverage: Every exported function, class, and type gets a `/** ... */` comment with a one-line description and `@example` where helpful
- Style: Concise. One line for obvious methods. 2-3 lines for methods with non-obvious behavior.

**P2. JSDoc on RPC public API**
- Files: `packages/rpc/src/procedure.ts`, `handler.ts`, `client.ts`, `types.ts`
- Same style as P1

**P3. JSDoc on plugin packages**
- Files: `packages/jwt/src/index.ts`, `packages/cache/src/*.ts`, `packages/rate-limit/src/index.ts`, `packages/compress/src/index.ts`, `packages/schema/src/index.ts`
- Same style as P1

**P4. Reposition benchmarks in README**
- File: `README.md`
- Change: Remove Fastify from the benchmark comparison table. Keep Express (CelsianJS wins 1.7x) and add a note about Hono on Workers being comparable. Frame the narrative as "significantly faster than Express with batteries included" not "slower than Fastify".

**P5. Lead README with task queue/cron story**
- File: `README.md`
- Change: Move the quick start example to show task queue + cron + API in one snippet. Current opening is a basic route handler (identical to every framework). New opening should demonstrate what makes CelsianJS different:
  ```typescript
  const app = createApp();
  app.get('/health', (req, reply) => reply.json({ ok: true }));
  
  // Background jobs — no BullMQ, no Redis required
  app.task('send-email', async ({ to, subject }) => { /* ... */ });
  app.enqueue('send-email', { to: 'user@example.com', subject: 'Welcome' });
  
  // Scheduled tasks — no node-cron package needed
  app.cron('cleanup', '0 3 * * *', async () => { /* ... */ });
  
  serve(app, { port: 3000 });
  ```

**P6. Per-package README files for npm**
- Files: `packages/core/README.md`, `packages/rpc/README.md`, `packages/jwt/README.md`, `packages/cache/README.md`, `packages/rate-limit/README.md`, `packages/compress/README.md`
- Each should have: one-line description, install command, minimal example, link to main docs
- These show on the npm package page — currently most packages have no README

---

### Dev2 — Landing Page + Demo

**L1. Deploy landing page to Vercel**
- Files: `site/`, new `site/package.json` or `vercel.json`
- Change: Set up as a static Vercel deployment. The `site/index.html` is already built — just needs deployment config.
- Domain: Use whatever's available (celsianjs.dev preferred, celsianjs.com, or celsian.dev)
- Note: This may require Kirby to configure the Vercel project and domain manually. The agent should set up the deployment config and push.

**L2. Update landing page benchmarks**
- File: `site/index.html`
- Change: Match the new README positioning — remove Fastify from comparisons, lead with the "application framework" angle

**L3. Build "SaaS backend in one file" demo**
- File: `examples/saas-demo/` (new directory)
- A single `src/index.ts` that demonstrates:
  - 5 API endpoints (health, users CRUD, dashboard stats)
  - JWT authentication with login/register
  - Background task: `send-welcome-email` (logs to console, simulates email)
  - Cron job: `daily-report` (runs at midnight, aggregates stats)
  - SSE endpoint: `/events` for real-time notifications
  - OpenAPI docs at `/docs`
  - Schema validation with Zod on all endpoints
  - Uses the new typed route API (no `as` casts)
- Include `package.json`, `tsconfig.json`, `README.md`
- The demo should be runnable with `npm install && npm run dev`
- Target: ~200-300 lines, showing feature density no other framework can match in a single file

**L4. Link demo from landing page and README**
- Files: `site/index.html`, `README.md`
- Add a "Try the demo" section linking to the `examples/saas-demo` directory

---

### Dev3 — Scaffolder + Cleanup

**C1. Fix silent catch blocks**
- Files: `packages/core/src/app.ts:394`, `packages/core/src/config.ts:48`
- Change: Add `console.error('[celsian]', error)` or `this.log?.error(error)` inside each catch block
- Test: Verify errors are logged (check console output in test)

**C2. Fix scaffolder version pinning**
- Files: `packages/create-celsian/src/templates/*.ts`
- Change: Replace hardcoded `"celsian": "^0.2.0"` with a dynamic version read from `../package.json` at build time, or use `"latest"` as default with a comment
- Better approach: Import the version from `create-celsian`'s own `package.json` and use that

**C3. Sanitize project name in scaffolder**
- File: `packages/create-celsian/src/index.ts:98`
- Change: After the `isAbsolute()` check, also reject names containing `..`, and verify the resolved path is a child of `process.cwd()`
- Test: Verify `../../etc` as project name is rejected with a helpful error

**C4. Fix dev script inconsistency**
- Files: `packages/create-celsian/src/templates/basic.ts`, `rest-api.ts`, `rpc-api.ts`, `full.ts`
- Change: All templates should use the same dev script pattern. Recommend `"dev": "npx tsx --watch src/index.ts"` for all (simpler, no dependency on CLI)
- Or: All use `"dev": "npx celsian dev"` — pick one and be consistent

**C5. Add CSP to Swagger UI HTML**
- File: `packages/core/src/plugins/openapi.ts`
- Change: Add a `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net;">` to the `swaggerHTML()` template
- This prevents the Swagger UI page from loading scripts from unexpected origins

**C6. Fix encapsulate: false in full template**
- File: `packages/create-celsian/src/templates/full.ts`
- Change: The security plugins (CORS, security headers, CSRF) should be registered with `{ encapsulate: false }` so they apply globally. Currently they may be scoped to the plugin's context.
- Verify: Check the generated code matches the pattern shown in the README/docs

---

## Phase 2 Review Agent

After PM merges all 3 worktree branches:

1. `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint` — all pass
2. Verify JSDoc renders on hover in VSCode for: `createApp`, `serve`, `reply.json`, `app.task`, `app.cron`
3. Verify `examples/saas-demo` runs: `cd examples/saas-demo && npm install && npm run dev` — server starts, `/docs` shows Swagger UI, all endpoints respond
4. Verify landing page builds: open `site/index.html` in browser, check no broken images/links, benchmarks match README
5. Verify no `as {` or `as any` casts in examples or templates (re-check after Phase 2 changes)
6. Verify all per-package READMEs exist and contain install + example
7. Report findings. Block Phase 3 until resolved.

---

## Phase 3: Ship

PM Agent handles:

**V1. Create changeset**
- Run `pnpm changeset` with a comprehensive description covering all changes
- Major categories: Security hardening, typed route API, engineering improvements, docs, demo

**V2. Version bump to 0.3.0**
- Run `pnpm changeset version` to bump all packages

**V3. Final verification**
- `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint`

**V4. Verify publish dry-run**
- `pnpm -r publish --dry-run` — check no `workspace:*` in outputs, all packages include `dist/` and `README.md`

**V5. Commit and tag**
- Commit with message: `feat: v0.3.0 — security hardening, typed routes, landing page, SaaS demo`
- Tag: `v0.3.0`
- Do NOT push or publish — Kirby decides when to ship

---

## Agent Assignment Summary

| Agent | Phase 1 | Phase 2 | Phase 3 |
|-------|---------|---------|---------|
| **PM** | Dispatch devs, manage merges | Dispatch devs, manage merges | Version bump, changelog, final verify |
| **Dev1** | Security hardening (S1-S9) | JSDoc + benchmarks + README (P1-P6) | — |
| **Dev2** | Engineering gaps (E1-E8) | Landing page + SaaS demo (L1-L4) | — |
| **Dev3** | Type inference (T1-T8) | Scaffolder + cleanup (C1-C6) | — |
| **Review** | Post-Phase 1 audit | Post-Phase 2 audit | Final pass |

**Total tasks**: 55
**Expected test count after sprint**: 709 existing + ~80-100 new = ~800+ tests
**Target rating improvement**: 6.5/10 -> 7.5-8/10

---

## Success Criteria

1. Zero `as` casts in any example or scaffolder template
2. All security findings from PRODUCT-REVIEW.md addressed
3. All packages have `engines` field
4. All user-facing packages have tests
5. Platform stubs don't publish to npm
6. CI runs typecheck
7. Landing page deployed
8. SaaS demo runs and showcases all differentiating features
9. Per-package READMEs on npm
10. `pnpm test && pnpm typecheck && pnpm lint` all pass
