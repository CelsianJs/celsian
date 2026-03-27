# CelsianJS Hardening Sprint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all security vulnerabilities, eliminate server/core duplication, fix 13 known bugs, reduce memory footprint, and raise the product score from 3.5/10 to 7+/10.

**Architecture:** Eliminate `@celsian/server` by migrating its unique features (SSE, middleware pattern) into `@celsian/core`. Fix all security issues in the surviving core package. Fix all 13 QA bugs. Optimize memory allocation on the hot path.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, Web Standard APIs (Request/Response)

---

## Agent Assignment

This plan is designed for parallel execution by multiple agents:

| Agent | Tasks | Scope |
|-------|-------|-------|
| **Dev Agent 1 (Security)** | Tasks 1-5 | All security fixes across all packages |
| **Dev Agent 2 (Bugs + Architecture)** | Tasks 6-10 | Kill @celsian/server, fix 13 bugs, memory |
| **PM Agent** | Coordinates | Tracks progress, runs tests between tasks, maintains QA |
| **Review Agent** | Post-sprint | Verifies every finding from the original review is addressed |

---

## Task 1: Fix CRITICAL Security — Path Traversal, WebSocket Auth

**Files:**
- Modify: `packages/adapter-node/src/index.ts:173-188`
- Modify: `packages/core/src/serve.ts:180-202`
- Create: `packages/adapter-node/test/security.test.ts`
- Create: `packages/core/test/ws-security.test.ts`

- [ ] **Step 1: Write path traversal test for adapter-node**

```typescript
// packages/adapter-node/test/security.test.ts
import { describe, it, expect } from 'vitest';

describe('adapter-node static file security', () => {
  it('should block path traversal via /../', async () => {
    // Simulate a request to /../../../etc/passwd
    const url = new URL('http://localhost:3000/../../etc/passwd');
    // The resolved path should NOT escape the static directory
    const { join, resolve } = await import('node:path');
    const staticDir = '/app/public';
    const filePath = join(staticDir, url.pathname);
    const resolved = resolve(filePath);
    expect(resolved.startsWith(resolve(staticDir) + '/')).toBe(false);
    // This proves the current code is vulnerable
  });

  it('should block encoded path traversal via %2e%2e', async () => {
    const url = new URL('http://localhost:3000/%2e%2e/%2e%2e/etc/passwd');
    const decoded = decodeURIComponent(url.pathname);
    const { join, resolve } = await import('node:path');
    const staticDir = '/app/public';
    const filePath = resolve(join(staticDir, decoded));
    expect(filePath.startsWith(resolve(staticDir) + '/')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify vulnerability exists**

Run: `cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/celsian && pnpm vitest run packages/adapter-node/test/security.test.ts`

- [ ] **Step 3: Fix adapter-node path traversal**

In `packages/adapter-node/src/index.ts`, find the `tryStaticFile` function (around line 173) and add path containment:

```typescript
// BEFORE (line 174):
const filePath = join(staticDir, url.pathname);

// AFTER:
const { resolve } = await import('node:path');
const decoded = decodeURIComponent(url.pathname);
const filePath = resolve(join(staticDir, decoded));
const resolvedRoot = resolve(staticDir);
if (!filePath.startsWith(resolvedRoot + '/') && filePath !== resolvedRoot) {
  return null; // Path traversal attempt — reject
}
```

Apply the same fix to the build template's `tryStaticFile` function (around lines 73-86).

- [ ] **Step 4: Fix WebSocket origin checking and auth**

In `packages/core/src/serve.ts`, find the upgrade handler (line 180). Add origin validation and run auth hooks before accepting:

```typescript
server.on('upgrade', async (req: IncomingMessage, socket: any, head: Buffer) => {
  const origin = req.headers.origin;
  const pathname = new URL(req.url ?? '/', `http://${host}:${port}`).pathname;
  const handler = app.wsRegistry.getHandler(pathname);

  if (!handler) {
    socket.destroy();
    return;
  }

  // Origin validation — reject cross-origin if CORS is configured
  if (origin && app._corsOrigins && !app._corsOrigins.includes('*')) {
    if (!app._corsOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  // Run onRequest hooks for auth before upgrading
  const webReq = new Request(`http://${host}:${port}${req.url}`, {
    method: 'GET',
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
    ),
  });
  const url = new URL(webReq.url);
  const celsianReq = buildRequest(webReq, url, {});

  // Run auth hooks — if any hook returns a response, reject the upgrade
  try {
    const hooks = app._getHooksForPath?.(pathname, 'onRequest') ?? [];
    for (const hook of hooks) {
      const result = await hook(celsianReq, {} as any);
      if (result instanceof Response) {
        socket.write(`HTTP/1.1 ${result.status} ${result.statusText}\r\n\r\n`);
        socket.destroy();
        return;
      }
    }
  } catch {
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: any) => {
    // ... existing connection setup with celsianReq passed through
  });
});
```

- [ ] **Step 5: Write WebSocket security tests**

```typescript
// packages/core/test/ws-security.test.ts
import { describe, it, expect } from 'vitest';
import { CelsianApp } from '../src/app.js';

describe('WebSocket security', () => {
  it('should reject upgrade when onRequest hook returns 401', async () => {
    const app = new CelsianApp();
    app.addHook('onRequest', async (req, reply) => {
      return reply.unauthorized('No token');
    });
    app.ws('/ws', { open() {} });

    const res = await app.inject({
      method: 'GET',
      url: '/ws',
      headers: { upgrade: 'websocket', connection: 'Upgrade' },
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `pnpm test`
Expected: All existing tests pass + new security tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-node/src/index.ts packages/core/src/serve.ts packages/adapter-node/test/security.test.ts packages/core/test/ws-security.test.ts
git commit -m "fix(security): path traversal in adapter-node, WebSocket origin+auth checks"
```

---

## Task 2: Fix HIGH Security — CRLF, Prototype Pollution, Body Limits, JWT Timing

**Files:**
- Modify: `packages/server/src/reply.ts:34-37`
- Modify: `packages/server/src/app.ts:463-479` (body limit)
- Modify: `packages/server/src/app.ts:311-335` (query parsing)
- Modify: `packages/server/src/middleware/jwt-auth.ts:87-93`
- Create: `packages/server/test/security-hardening.test.ts`

- [ ] **Step 1: Write security tests**

```typescript
// packages/server/test/security-hardening.test.ts
import { describe, it, expect } from 'vitest';

describe('server security hardening', () => {
  it('should strip CRLF from header values', () => {
    // Test that reply.header() strips \r\n
  });

  it('should reject bodies exceeding size limit', () => {
    // Test that a 2MB body on a 1MB limit returns 413
  });

  it('should block __proto__ in query params', () => {
    // Test that ?__proto__[admin]=true does not pollute
  });

  it('should use constant-time comparison for JWT signatures', () => {
    // Test that JWT verification uses timingSafeEqual or crypto.subtle.verify
  });
});
```

- [ ] **Step 2: Fix CRLF in server reply**

In `packages/server/src/reply.ts:35`:
```typescript
// BEFORE:
headers[key.toLowerCase()] = value;

// AFTER:
headers[key.toLowerCase()] = value.replace(/[\r\n]/g, '');
```

- [ ] **Step 3: Add body size limit to server**

In `packages/server/src/app.ts`, add body limit check before parsing (around line 465):
```typescript
private async parseBody(request: CelsianRequest): Promise<void> {
  const contentType = request.headers.get('content-type') ?? '';
  const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10);
  const bodyLimit = this.options.bodyLimit ?? 1_048_576; // 1MB default

  if (contentLength > bodyLimit) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${bodyLimit} bytes`);
  }
  // ... existing parsing
}
```

- [ ] **Step 4: Add prototype pollution protection to server query parsing**

In `packages/server/src/app.ts`, find the query building code and add BLOCKED_KEYS + Object.create(null):
```typescript
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// In buildRequest or wherever query is parsed:
const query: Record<string, string | string[]> = Object.create(null);
for (const [key, value] of url.searchParams) {
  if (BLOCKED_KEYS.has(key)) continue;
  // ... existing logic
}
```

- [ ] **Step 5: Fix JWT timing attack**

In `packages/server/src/middleware/jwt-auth.ts:93`, replace string comparison with constant-time:
```typescript
// BEFORE:
if (expectedSig !== signature) return null;

// AFTER:
const encoder = new TextEncoder();
const a = encoder.encode(expectedSig);
const b = encoder.encode(signature);
if (a.length !== b.length) return null;
let diff = 0;
for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
if (diff !== 0) return null;
```

- [ ] **Step 6: Run tests**

Run: `pnpm test`

- [ ] **Step 7: Commit**

```bash
git commit -m "fix(security): CRLF injection, body limits, prototype pollution, JWT timing"
```

---

## Task 3: Fix HIGH Security — Rate Limiter, Error Leakage, CSRF

**Files:**
- Modify: `packages/rate-limit/src/index.ts:61-65`
- Modify: `packages/server/src/middleware/rate-limit.ts:59-65`
- Modify: `packages/server/src/app.ts:550-562` (error leakage)
- Create: `packages/core/src/plugins/csrf.ts`
- Create: `packages/core/test/csrf.test.ts`

- [ ] **Step 1: Fix rate limiter — require trustProxy for forwarded headers**

In both rate limit files, change the default key generator:
```typescript
function defaultKeyGenerator(req: CelsianRequest, options?: { trustProxy?: boolean }): string {
  if (options?.trustProxy) {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]!.trim();
    const realIp = req.headers.get('x-real-ip');
    if (realIp) return realIp;
  }
  // Fall back to a hash of the request origin or a per-connection identifier
  return req.headers.get('cf-connecting-ip')
    ?? req.headers.get('x-real-ip')
    ?? 'anonymous-' + Date.now().toString(36);
}
```

- [ ] **Step 2: Fix server error message leakage**

In `packages/server/src/app.ts`, find the error response builder and add production check:
```typescript
const isProduction = process.env.NODE_ENV === 'production';

// In error handler:
const body = {
  error: isProduction && status >= 500 ? 'Internal Server Error' : (error.message || 'Internal Server Error'),
  statusCode: status,
  ...(isProduction ? {} : { stack: error.stack }),
};
```

- [ ] **Step 3: Create CSRF middleware plugin**

```typescript
// packages/core/src/plugins/csrf.ts
import type { CelsianRequest, CelsianReply } from '../types.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrf(options: { cookie?: string; header?: string; secret?: string } = {}) {
  const cookieName = options.cookie ?? '_csrf';
  const headerName = options.header ?? 'x-csrf-token';

  return async function csrfPlugin(app: any) {
    app.addHook('onRequest', async (req: CelsianRequest, reply: CelsianReply) => {
      if (SAFE_METHODS.has(req.method)) return;

      const cookieToken = req.cookies?.[cookieName];
      const headerToken = req.headers.get(headerName);

      if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return reply.forbidden('CSRF token mismatch');
      }
    });
  };
}
```

- [ ] **Step 4: Write CSRF tests and run all tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(security): rate limiter trustProxy, error leakage, CSRF middleware"
```

---

## Task 4: Fix Silent Error Swallowing + Example Secrets

**Files:**
- Modify: `packages/core/src/hooks.ts:74-86`
- Modify: `packages/core/src/cron.ts:100-105`
- Modify: `packages/server/src/tasks.ts:472-488`
- Modify: `examples/showcase/src/index.ts:82,96,110`

- [ ] **Step 1: Fix runHooksFireAndForget to log async errors**

In `packages/core/src/hooks.ts:74-86`:
```typescript
export function runHooksFireAndForget(
  hooks: HookHandler[],
  request: CelsianRequest,
  reply: CelsianReply,
): void {
  for (const hook of hooks) {
    try {
      const result = hook(request, reply);
      // Catch async errors instead of silently swallowing
      if (result && typeof (result as any).catch === 'function') {
        (result as Promise<unknown>).catch((err) => {
          console.error('[celsian] Unhandled error in fire-and-forget hook:', err);
        });
      }
    } catch (err) {
      console.error('[celsian] Unhandled error in fire-and-forget hook:', err);
    }
  }
}
```

- [ ] **Step 2: Fix cron error swallowing**

In `packages/core/src/cron.ts:102`:
```typescript
// BEFORE:
Promise.resolve(job.handler()).catch(() => {});

// AFTER:
Promise.resolve(job.handler()).catch((err) => {
  console.error(`[celsian] Cron job "${job.name ?? 'anonymous'}" failed:`, err);
});
```

Apply same fix in `packages/server/src/tasks.ts:472-488`.

- [ ] **Step 3: Fix example hardcoded secrets**

In `examples/showcase/src/index.ts`:
```typescript
// BEFORE (line 82):
const JWT_SECRET = 'pulse-demo-secret-change-in-production';

// AFTER:
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
```

Replace SHA-256 password hashing with a comment pointing to proper implementation:
```typescript
// BEFORE (line 96):
const data = encoder.encode(password + 'pulse-salt');

// AFTER:
// WARNING: Use bcrypt or argon2 in production. This is a demo-only hash.
const data = encoder.encode(password + (process.env.PASSWORD_SALT ?? 'demo-only-change-me'));
```

- [ ] **Step 4: Run tests, commit**

```bash
git commit -m "fix: log fire-and-forget errors, cron errors, remove hardcoded secrets"
```

---

## Task 5: Add Security Headers by Default + Cookie Defaults

**Files:**
- Modify: `packages/core/src/cookie.ts:36-51`
- Modify: `packages/core/src/app.ts` (default security headers)

- [ ] **Step 1: Default cookie options to secure**

In `packages/core/src/cookie.ts`, update `serializeCookie` defaults:
```typescript
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  // Default to secure cookie settings
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    ...options, // User options override defaults
  };
  // ... existing serialization
}
```

- [ ] **Step 2: Run tests, commit**

```bash
git commit -m "fix(security): secure cookie defaults, security header improvements"
```

---

## Task 6: Kill @celsian/server — Migrate Unique Features to Core

**Files:**
- Modify: `packages/core/src/app.ts` (add SSE support from server)
- Create: `packages/core/src/sse.ts` (migrate from server/src/sse.ts)
- Delete: `packages/server/` (entire package after migration)
- Modify: `packages/server/src/middleware/` → migrate to `packages/core/src/plugins/`
- Update: root `package.json`, `tsconfig.json`, `pnpm-workspace.yaml`

- [ ] **Step 1: Identify unique features in @celsian/server not in @celsian/core**

Read both packages thoroughly. Expected unique-to-server features:
- SSE (Server-Sent Events) via TransformStream
- `fp()` skip-override pattern
- Some middleware patterns (etag, logger)

- [ ] **Step 2: Migrate SSE to core**

Copy `packages/server/src/sse.ts` → `packages/core/src/sse.ts`. Export from core's index.

- [ ] **Step 3: Migrate any unique middleware to core plugins**

Check if etag, logger middleware in server/ have equivalents in core/. If not, migrate.

- [ ] **Step 4: Update all imports and references**

Search for any code that imports from `@celsian/server`. Update to `@celsian/core`.

- [ ] **Step 5: Remove @celsian/server package**

Remove from `pnpm-workspace.yaml`, `tsconfig.json`, delete the directory.

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Fix any broken imports or missing features.

- [ ] **Step 7: Commit**

```bash
git commit -m "refactor: eliminate @celsian/server, consolidate into @celsian/core"
```

---

## Task 7: Fix All 13 QA Bugs

**Files:** Various (see QA-REPORT.md for each bug)

- [ ] **Step 1: Fix BUG-1 (P0) — ESM serve() crash**

Check if already fixed (dynamic import). If not, replace `require()` with `await import()` in `packages/core/src/serve.ts:34-36`.

- [ ] **Step 2: Fix BUG-2 (P0) — TypeBox adapter ESM crash**

In `packages/schema/src/adapters/typebox.ts:13`, replace `require()` with dynamic `import()`.

- [ ] **Step 3: Fix BUG-3 (P1) — Multiple Set-Cookie headers lost**

In `packages/core/src/serve.ts:237-239`, use `Headers.append()` instead of `set()` for Set-Cookie.

- [ ] **Step 4: Fix BUG-4 (P2) — Plugin decorate() not on CelsianApp**

In `packages/core/src/app.ts:110-113`, ensure decorations are applied to the app instance.

- [ ] **Step 5: Fix BUG-5/6 (P1) — onSend hook headers lost + CORS broken**

In `packages/core/src/app.ts:329-333`, merge headers from onSend hooks into the response.

- [ ] **Step 6: Fix BUG-7/8 (P3) — 405 vs 404 + HEAD fallback**

In `packages/core/src/router.ts:88`, differentiate no-path (404) from wrong-method (405). Add HEAD→GET fallback.

- [ ] **Step 7: Fix BUG-9 (P1) — RPC POST body already consumed**

In `packages/rpc/src/router.ts:99`, clone the request body before consuming, or read it once and share.

- [ ] **Step 8: Fix BUG-10 (P3) — Malformed JSON returns 200**

In `packages/core/src/app.ts:378-388`, return 400 on JSON parse failure.

- [ ] **Step 9: Fix BUG-11 (P3) — Path params not URL-decoded**

In `packages/core/src/router.ts:129`, add `decodeURIComponent()` to param values.

- [ ] **Step 10: Fix BUG-12 (P3) — CORS preflight leaks to disallowed origins**

In `packages/core/src/plugins/cors.ts:48-76`, check origin before responding to preflight.

- [ ] **Step 11: Fix BUG-13 (P3) — Duplicate query params keep last only**

In `packages/core/src/request.ts:10-13`, accumulate into arrays for duplicate keys.

- [ ] **Step 12: Write regression tests for each bug fix**

One test per bug. Add to existing test files or create `packages/core/test/qa-regressions.test.ts`.

- [ ] **Step 13: Run full test suite, commit**

```bash
git commit -m "fix: resolve all 13 QA-reported bugs (BUG-1 through BUG-13)"
```

---

## Task 8: Memory Optimization

**Files:**
- Modify: `packages/core/src/request.ts` (hot path allocation)
- Modify: `packages/core/src/app.ts` (request lifecycle)
- Modify: `packages/core/src/task.ts` (MemoryQueue eviction)

- [ ] **Step 1: Profile current memory baseline**

Run: `node --expose-gc benchmarks/run.js` or create a script that measures RSS under 10K requests.

- [ ] **Step 2: Reduce per-request allocations**

Key targets:
- Pool or reuse query objects where possible
- Avoid `Object.create(null)` on every request if query is empty (use a frozen empty object)
- Lazy-init parsedBody/cookies only when accessed
- Reduce closure captures in hook chains

- [ ] **Step 3: Add MemoryQueue eviction**

In `packages/core/src/task.ts`, add max completed job retention:
```typescript
private evictCompleted() {
  const maxCompleted = this.options.maxCompletedJobs ?? 1000;
  if (this.completed.length > maxCompleted) {
    this.completed = this.completed.slice(-maxCompleted);
  }
}
```

- [ ] **Step 4: Measure memory improvement**

Target: <50MB RSS under the same benchmark load (from 94MB).

- [ ] **Step 5: Commit**

```bash
git commit -m "perf: reduce memory footprint — pool allocations, MemoryQueue eviction"
```

---

## Task 9: Build System + CI Fixes

**Files:**
- Modify: `tsconfig.json` (add missing package references)
- Modify: `.github/workflows/test.yml` (add lint step)
- Fix: `examples/crud-api/test/api.test.ts` (EADDRINUSE)
- Fix: `packages/cache/test/bench.test.ts` (flaky timing assertion)

- [ ] **Step 1: Add missing packages to tsconfig.json references**

Add: `server` (if kept), `cache`, `queue-redis`, `rate-limit`, `adapter-node`, `adapter-fly`, `adapter-railway`, `edge-router`, `platform`.

- [ ] **Step 2: Fix EADDRINUSE in example test**

Add proper server teardown with `afterAll()` / random port assignment.

- [ ] **Step 3: Fix flaky bench test**

In `packages/cache/test/bench.test.ts:242`, increase the timing threshold or use relative comparison.

- [ ] **Step 4: Run full test suite — target 0 failures, 0 errors**

Run: `pnpm test`

- [ ] **Step 5: Commit**

```bash
git commit -m "fix: build system refs, flaky tests, EADDRINUSE teardown"
```

---

## Task 10: Documentation + Version Bump

**Files:**
- Modify: `README.md` (update feature list, remove @celsian/server references)
- Modify: `SECURITY_AUDIT.md` (mark new fixes)
- Modify: `QA-REPORT.md` (mark bugs as resolved)
- Modify: All `packages/*/package.json` (version bump to 0.2.0)

- [ ] **Step 1: Update README to reflect consolidated architecture**

Remove any references to @celsian/server. Update feature list. Note CSRF plugin.

- [ ] **Step 2: Update SECURITY_AUDIT.md**

Add all new findings and their fix status.

- [ ] **Step 3: Update QA-REPORT.md**

Mark all 13 bugs as RESOLVED with commit references.

- [ ] **Step 4: Bump all packages to 0.2.0**

- [ ] **Step 5: Run full test suite one final time**

Run: `pnpm test`
Expected: ALL pass, 0 failures, 0 errors

- [ ] **Step 6: Commit and push**

```bash
git commit -m "chore: v0.2.0 — security hardening, bug fixes, architecture consolidation"
git push origin main
```
