# CelsianJS v0.3.0 Sprint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.3.0 with all security findings fixed, typed route API, full test coverage, landing page, and SaaS demo.

**Architecture:** 3 parallel dev agents in isolated worktrees per phase, 1 review agent after each phase merge, 1 PM agent orchestrating. Phase 1 = security + engineering + type inference. Phase 2 = docs + positioning + cleanup. Phase 3 = version bump + ship prep.

**Tech Stack:** TypeScript 5.7, Vitest 3, Biome 2.4, pnpm workspaces, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-03-31-celsian-hardening-sprint-design.md`

---

## Phase 1 Agent Assignments

| Agent | Branch Name | Scope |
|-------|------------|-------|
| Dev1 | `sprint/security` | Tasks S1-S9 |
| Dev2 | `sprint/engineering` | Tasks E1-E8 |
| Dev3 | `sprint/typed-routes` | Tasks T1-T8 |

All agents work from the `celsian/` directory. Run `pnpm install && pnpm build` before starting.

---

## Dev1: Security Hardening (Tasks S1-S9)

### Task S1: Fix CORS+credentials default in scaffolder

**Files:**
- Modify: `packages/create-celsian/src/templates/full.ts:191-195`

- [ ] **Step 1: Find and fix the CORS default**

In `packages/create-celsian/src/templates/full.ts`, find the line in the generated `.env.example` content that sets `CORS_ORIGIN=*` and change it to `CORS_ORIGIN=http://localhost:3000`.

Also find the CORS registration in the generated code and add a comment:

```typescript
// WARNING: credentials: true with a wildcard origin accepts authenticated
// requests from ANY website. Set CORS_ORIGIN to your frontend URL in production.
```

- [ ] **Step 2: Write test**

Create `packages/create-celsian/test/security.test.ts`:

```typescript
// @celsian/create-celsian — Security default tests
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Import the full template content generator
// We test the generated string output, not file generation
const __dirname = dirname(fileURLToPath(import.meta.url));

describe("full template security defaults", () => {
  it("should not default CORS_ORIGIN to wildcard", async () => {
    // Dynamically import the template to get the generated content
    const { fullTemplate } = await import("../src/templates/full.js");
    const files = fullTemplate("test-project");
    const envExample = files.find((f: { path: string }) => f.path.includes(".env.example"));
    expect(envExample?.content).not.toContain("CORS_ORIGIN=*");
    expect(envExample?.content).toContain("CORS_ORIGIN=http://localhost:3000");
  });
});
```

- [ ] **Step 3: Run test**

Run: `cd packages/create-celsian && pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/create-celsian/
git commit -m "fix(security): change CORS default from wildcard to localhost"
```

---

### Task S2: Refuse default JWT secret in production

**Files:**
- Modify: `packages/create-celsian/src/templates/full.ts`

- [ ] **Step 1: Add production guard to generated auth.ts**

In the full template, find the generated auth plugin code where it reads `JWT_SECRET`. Add after the secret assignment:

```typescript
// Refuse to run with default secret in production
if (process.env.NODE_ENV === "production" && secret === "dev-secret-change-me") {
  throw new Error(
    "JWT_SECRET must be set in production. Generate one with: node -e \\"console.log(require('crypto').randomBytes(32).toString('hex'))\\""
  );
}
```

- [ ] **Step 2: Add test to security.test.ts**

```typescript
it("should include JWT production guard in generated auth plugin", async () => {
  const { fullTemplate } = await import("../src/templates/full.js");
  const files = fullTemplate("test-project");
  const authFile = files.find((f: { path: string }) => f.path.includes("auth"));
  expect(authFile?.content).toContain('NODE_ENV === "production"');
  expect(authFile?.content).toContain("dev-secret-change-me");
  expect(authFile?.content).toContain("JWT_SECRET must be set in production");
});
```

- [ ] **Step 3: Run test, verify pass**

Run: `cd packages/create-celsian && pnpm test`

- [ ] **Step 4: Commit**

```bash
git add packages/create-celsian/
git commit -m "fix(security): refuse default JWT secret in production mode"
```

---

### Task S3: HTML-escape Swagger UI interpolations

**Files:**
- Modify: `packages/core/src/plugins/openapi.ts:236-261`
- Test: `packages/core/test/openapi.test.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/core/test/openapi.test.ts`:

```typescript
describe("swaggerHTML XSS prevention", () => {
  it("should escape script tags in title", async () => {
    const app = createApp();
    app.register(openapi({ title: '<script>alert("xss")</script>' }));
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/docs" });
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `pnpm test -- packages/core/test/openapi.test.ts`
Expected: FAIL — title is interpolated unescaped

- [ ] **Step 3: Add escapeHtml helper and apply it**

In `packages/core/src/plugins/openapi.ts`, add before `swaggerHTML`:

```typescript
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

Then in `swaggerHTML`, change:
- `<title>${title}` → `<title>${escapeHtml(title)}`
- `url: '${jsonPath}'` → `url: '${escapeHtml(jsonPath)}'`

- [ ] **Step 4: Run test, verify PASS**

Run: `pnpm test -- packages/core/test/openapi.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/openapi.ts packages/core/test/openapi.test.ts
git commit -m "fix(security): escape HTML in Swagger UI title and jsonPath"
```

---

### Task S4: Remove RegExp deserialization from RPC wire

**Files:**
- Modify: `packages/rpc/src/wire.ts:76-88`
- Test: `packages/rpc/test/wire.test.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/rpc/test/wire.test.ts`:

```typescript
describe("wire security", () => {
  it("should not deserialize RegExp from wire data", () => {
    // Encode a RegExp
    const encoded = encode({ pattern: /test/gi });
    const decoded = decode(encoded) as { pattern: unknown };
    // Should come back as a string, NOT a RegExp
    expect(decoded.pattern).not.toBeInstanceOf(RegExp);
    expect(typeof decoded.pattern).toBe("string");
  });

  it("should not allow ReDoS via crafted RegExp pattern", () => {
    // Even if someone crafts wire data with TAG_REGEXP, it should not create a RegExp
    const malicious = JSON.stringify({ __type: "RegExp", value: "/(a+)+$/g" });
    const decoded = decode(JSON.parse(malicious));
    expect(decoded).not.toBeInstanceOf(RegExp);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `pnpm test -- packages/rpc/test/wire.test.ts`

- [ ] **Step 3: Replace RegExp case with string return**

In `packages/rpc/src/wire.ts`, replace the `case TAG_REGEXP:` block (lines 76-88) with:

```typescript
case TAG_REGEXP: {
  // Security: do not reconstruct RegExp from untrusted input (ReDoS risk).
  // Return the raw pattern string instead.
  return v;
}
```

In the `encode` function, change the RegExp encoding to serialize as a string type instead:

Find the RegExp encoding case and change it to:
```typescript
if (value instanceof RegExp) {
  return { __type: TAG_STRING, value: value.toString() };
}
```

Or if `TAG_STRING` doesn't exist, just return the `.toString()` value directly without a tag.

- [ ] **Step 4: Run test, verify PASS**

Run: `pnpm test -- packages/rpc/test/wire.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/rpc/src/wire.ts packages/rpc/test/wire.test.ts
git commit -m "fix(security): remove RegExp deserialization from RPC wire (ReDoS prevention)"
```

---

### Task S5: Fix stack trace leak when NODE_ENV unset

**Files:**
- Modify: `packages/core/src/errors.ts:3-6`
- Test: `packages/core/test/errors.test.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/core/test/errors.test.ts`:

```typescript
describe("isDev defaults", () => {
  it("should NOT leak stack traces when NODE_ENV is unset", () => {
    // When NODE_ENV is unset, errors should behave as production (safe by default)
    const error = new HttpError(500, "secret internal details");
    const json = error.toJSON();
    // In production mode, stack should not be present
    // Note: this test validates the behavior when NODE_ENV !== 'development'
    // The isDev flag is computed at module load time
    if (process.env.NODE_ENV !== "development") {
      expect(json).not.toHaveProperty("stack");
    }
  });
});
```

- [ ] **Step 2: Fix the isDev computation**

In `packages/core/src/errors.ts`, change lines 3-6 from:

```typescript
const isDev =
  typeof process !== "undefined"
    ? process.env.NODE_ENV !== "production" && process.env.CELSIAN_ENV !== "production"
    : true;
```

To:

```typescript
const isDev =
  typeof process !== "undefined"
    ? process.env.NODE_ENV === "development" || process.env.CELSIAN_ENV === "development"
    : false;
```

This makes production the **default** — you must explicitly opt into dev mode.

- [ ] **Step 3: Run full test suite to check for regressions**

Run: `pnpm test`
Expected: All 709+ tests pass. Some tests that relied on `isDev` being true by default may need `NODE_ENV=development` set.

- [ ] **Step 4: Fix any broken tests by adding NODE_ENV=development**

If any tests fail because they expected dev-mode behavior, add `process.env.NODE_ENV = "development"` in their `beforeAll` and restore in `afterAll`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/errors.ts packages/core/test/
git commit -m "fix(security): default to production mode when NODE_ENV is unset"
```

---

### Task S6: Add security to all scaffolder templates

**Files:**
- Modify: `packages/create-celsian/src/templates/basic.ts`
- Modify: `packages/create-celsian/src/templates/rest-api.ts`
- Modify: `packages/create-celsian/src/templates/rpc-api.ts`

- [ ] **Step 1: Add CORS and security imports to each template**

For each of `basic.ts`, `rest-api.ts`, and `rpc-api.ts`, add to the generated `src/index.ts`:

```typescript
import { cors } from "@celsian/core/plugins/cors";
import { security } from "@celsian/core/plugins/security";
```

And after `createApp()`, add:

```typescript
await app.register(cors());
await app.register(security(), { encapsulate: false });
```

- [ ] **Step 2: Add test**

Add to `packages/create-celsian/test/security.test.ts`:

```typescript
for (const template of ["basic", "rest-api", "rpc-api"]) {
  it(`${template} template should include security defaults`, async () => {
    const mod = await import(`../src/templates/${template}.js`);
    const templateFn = Object.values(mod)[0] as (name: string) => { path: string; content: string }[];
    const files = templateFn("test-project");
    const indexFile = files.find((f) => f.path.includes("index.ts") || f.path.includes("index"));
    expect(indexFile?.content).toContain("cors");
    expect(indexFile?.content).toContain("security");
  });
}
```

- [ ] **Step 3: Run test, verify PASS**

Run: `cd packages/create-celsian && pnpm test`

- [ ] **Step 4: Commit**

```bash
git add packages/create-celsian/
git commit -m "fix(security): add CORS and security headers to all scaffolder templates"
```

---

### Task S7: Fix rate limiter default key generator

**Files:**
- Modify: `packages/rate-limit/src/index.ts:73-78`
- Test: `packages/rate-limit/test/rate-limit.test.ts`

- [ ] **Step 1: Add warning log**

In `packages/rate-limit/src/index.ts`, modify the non-trustProxy branch of `createDefaultKeyGenerator`:

```typescript
return (req: CelsianRequest): string => {
  // Log warning once — rate limiting is effectively disabled without client identification
  if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn(
      "[celsian] rate-limit: trustProxy is false and no keyGenerator provided. " +
      "Rate limiting is effectively disabled. Set trustProxy: true or provide a custom keyGenerator."
    );
  }
  return `anonymous-${Date.now().toString(36)}`;
};
```

Add `let warnedNoKey = false;` at the top of the file (module scope).

- [ ] **Step 2: Write test**

Add to the rate-limit test file:

```typescript
it("should warn when rate limiting is effectively disabled", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
  try {
    const app = createApp();
    app.register(rateLimit({ max: 10, window: 60_000 }));
    await app.ready();
    await app.inject({ method: "GET", url: "/" });
    expect(warnings.some((w) => w.includes("rate-limit"))).toBe(true);
  } finally {
    console.warn = origWarn;
  }
});
```

- [ ] **Step 3: Run test, verify PASS**

Run: `pnpm test -- packages/rate-limit/test/`

- [ ] **Step 4: Commit**

```bash
git add packages/rate-limit/
git commit -m "fix(rate-limit): warn when default key generator makes rate limiting a no-op"
```

---

### Task S8: Add root directory parameter to sendFile

**Files:**
- Modify: `packages/core/src/reply.ts:156-178`
- Modify: `packages/core/src/types.ts:71`
- Test: `packages/core/test/reply.test.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/core/test/reply.test.ts` (or create a new `packages/core/test/sendfile-security.test.ts`):

```typescript
describe("sendFile with root directory", () => {
  it("should reject path traversal when root is specified", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => {
      return reply.sendFile("../../../etc/passwd", { root: "/app/static" });
    });
    const res = await app.inject({ method: "GET", url: "/file" });
    expect(res.status).toBe(403);
  });

  it("should serve files within root directory", async () => {
    const app = createApp();
    // Use a real file that exists
    app.get("/file", async (_req, reply) => {
      return reply.sendFile("package.json", { root: process.cwd() });
    });
    const res = await app.inject({ method: "GET", url: "/file" });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `pnpm test -- packages/core/test/sendfile-security.test.ts`
Expected: FAIL — sendFile doesn't accept options parameter

- [ ] **Step 3: Update type and implementation**

In `packages/core/src/types.ts`, change line 71:
```typescript
sendFile(filePath: string, options?: { root?: string }): Promise<Response>;
```

In `packages/core/src/reply.ts`, update `sendFile`:
```typescript
async sendFile(filePath: string, options?: { root?: string }): Promise<Response> {
  sent = true;
  try {
    const { readFile, stat } = await import("node:fs/promises");
    const { extname, resolve } = await import("node:path");
    let resolvedPath: string;
    if (options?.root) {
      const resolvedRoot = resolve(options.root);
      resolvedPath = resolve(resolvedRoot, filePath);
      // Path traversal check: resolved path must be within root
      if (!resolvedPath.startsWith(resolvedRoot)) {
        return new Response(JSON.stringify({ error: "Forbidden", statusCode: 403, code: "PATH_TRAVERSAL" }), {
          status: 403,
          headers: buildHeaders({ "content-type": "application/json; charset=utf-8" }),
        });
      }
    } else {
      resolvedPath = resolve(filePath);
    }
    await stat(resolvedPath);
    const data = await readFile(resolvedPath);
    const ext = extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    return new Response(data, {
      status: statusCode,
      headers: buildHeaders({ "content-type": contentType, ...headers }),
    });
  } catch {
    return new Response(JSON.stringify({ error: "Not Found", statusCode: 404, code: "NOT_FOUND" }), {
      status: 404,
      headers: buildHeaders({ "content-type": "application/json; charset=utf-8" }),
    });
  }
},
```

- [ ] **Step 4: Run test, verify PASS**

Run: `pnpm test -- packages/core/test/`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reply.ts packages/core/src/types.ts packages/core/test/
git commit -m "feat(reply): add root directory parameter to sendFile for path traversal prevention"
```

---

### Task S9: Run full test suite and verify

- [ ] **Step 1: Build and test everything**

```bash
pnpm build && pnpm test && pnpm typecheck && pnpm lint
```

Expected: All pass. If failures, fix them before committing.

- [ ] **Step 2: Commit any remaining fixes**

```bash
git add -A && git commit -m "fix: resolve test regressions from security hardening"
```

---

## Dev2: Engineering Gaps (Tasks E1-E8)

### Task E1: Add engines field to all packages

**Files:**
- Modify: All `packages/*/package.json` + root `package.json`

- [ ] **Step 1: Add engines to every package.json**

For every `packages/*/package.json`, add:
```json
"engines": {
  "node": ">=20"
}
```

For root `package.json`, add:
```json
"engines": {
  "node": ">=20",
  "pnpm": ">=9"
}
```

- [ ] **Step 2: Verify**

```bash
grep -rL '"engines"' packages/*/package.json
```

Expected: No output (all files have engines)

- [ ] **Step 3: Commit**

```bash
git add packages/*/package.json package.json
git commit -m "chore: add engines field (node>=20) to all packages"
```

---

### Task E2: Write CLI tests

**Files:**
- Create: `packages/cli/test/cli.test.ts`

- [ ] **Step 1: Create test file**

Read the CLI source files in `packages/cli/src/commands/` to understand what each command does. Then write tests:

```typescript
// @celsian/cli — CLI command tests
import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("CLI commands", () => {
  describe("generate route", () => {
    it("should create a route file with correct template", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "celsian-cli-"));
      try {
        // Import the generate command logic
        const { generateRoute } = await import("../src/commands/generate.js");
        await generateRoute("users", { outDir: tmp });
        const routeFile = join(tmp, "users.ts");
        expect(existsSync(routeFile)).toBe(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("generate rpc", () => {
    it("should create an RPC procedure file", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "celsian-cli-"));
      try {
        const { generateRpc } = await import("../src/commands/generate.js");
        await generateRpc("getUser", { outDir: tmp });
        const rpcFile = join(tmp, "getUser.ts");
        expect(existsSync(rpcFile)).toBe(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
```

Note: Read the actual CLI source to match the real function names and signatures. The above is a template — adjust based on what's actually exported.

- [ ] **Step 2: Run test**

Run: `pnpm test -- packages/cli/test/`

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/
git commit -m "test(cli): add tests for generate route and generate rpc commands"
```

---

### Task E3: Write scaffolder tests

**Files:**
- Create: `packages/create-celsian/test/scaffolder.test.ts`

- [ ] **Step 1: Create test file**

```typescript
// @celsian/create-celsian — Scaffolder tests
import { describe, it, expect } from "vitest";

describe("scaffolder templates", () => {
  for (const templateName of ["basic", "rest-api", "rpc-api", "full"]) {
    describe(templateName, () => {
      it("should generate valid file structure", async () => {
        const mod = await import(`../src/templates/${templateName}.js`);
        const templateFn = Object.values(mod)[0] as (name: string) => { path: string; content: string }[];
        const files = templateFn("my-test-project");
        expect(files.length).toBeGreaterThan(0);
        // Every template must have package.json and src/index.ts
        expect(files.some((f) => f.path.includes("package.json"))).toBe(true);
        expect(files.some((f) => f.path.includes("index.ts") || f.path.includes("src/index"))).toBe(true);
      });

      it("should include correct project name in package.json", async () => {
        const mod = await import(`../src/templates/${templateName}.js`);
        const templateFn = Object.values(mod)[0] as (name: string) => { path: string; content: string }[];
        const files = templateFn("my-cool-api");
        const pkgJson = files.find((f) => f.path.includes("package.json"));
        expect(pkgJson?.content).toContain('"my-cool-api"');
      });
    });
  }
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test -- packages/create-celsian/test/scaffolder.test.ts`

- [ ] **Step 3: Commit**

```bash
git add packages/create-celsian/test/
git commit -m "test(scaffolder): add template generation and structure tests"
```

---

### Task E4: Write adapter-fly and adapter-railway tests

**Files:**
- Create: `packages/adapter-fly/test/adapter.test.ts`
- Create: `packages/adapter-railway/test/adapter.test.ts`

- [ ] **Step 1: Read each adapter's source**

Read `packages/adapter-fly/src/index.ts` and `packages/adapter-railway/src/index.ts` to understand exports.

- [ ] **Step 2: Write tests**

For each adapter, create a test that verifies the exports exist and the adapter function returns the expected shape. Pattern:

```typescript
// @celsian/adapter-{name} — Adapter tests
import { describe, it, expect } from "vitest";

describe("adapter-{name}", () => {
  it("should export the adapter function", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.default === "function" || typeof Object.values(mod)[0] === "function").toBe(true);
  });
});
```

Adjust based on the actual exports found in step 1.

- [ ] **Step 3: Run tests, commit**

```bash
pnpm test -- packages/adapter-fly/ packages/adapter-railway/
git add packages/adapter-fly/test/ packages/adapter-railway/test/
git commit -m "test(adapters): add tests for fly and railway adapters"
```

---

### Task E5: Mark platform package as private

**Files:**
- Modify: `packages/platform/package.json`

- [ ] **Step 1: Add private flag**

Add `"private": true` to `packages/platform/package.json`.

- [ ] **Step 2: Commit**

```bash
git add packages/platform/package.json
git commit -m "chore(platform): mark as private — stub implementations should not publish"
```

---

### Task E6: Add typecheck to CI

**Files:**
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Add typecheck step**

In `.github/workflows/test.yml`, in the `test` job, add after `- run: pnpm test`:

```yaml
      - run: pnpm typecheck
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add typecheck step to test pipeline"
```

---

### Task E7: Verify workspace:* resolves on publish

**Files:**
- Create: `scripts/verify-publish.sh`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Create verification script**

```bash
#!/bin/bash
# Verify that workspace:* dependencies are resolved before publish
set -e
echo "Checking for unresolved workspace:* dependencies..."
FOUND=$(find packages/*/package.json -exec grep -l 'workspace:' {} \; 2>/dev/null || true)
if [ -n "$FOUND" ]; then
  echo "ERROR: Found unresolved workspace: dependencies in:"
  echo "$FOUND"
  exit 1
fi
echo "All workspace dependencies resolved."
```

- [ ] **Step 2: Add to release workflow**

In `.github/workflows/release.yml`, add a step before the publish step:

```yaml
      - name: Verify no workspace dependencies
        run: bash scripts/verify-publish.sh
```

- [ ] **Step 3: Commit**

```bash
chmod +x scripts/verify-publish.sh
git add scripts/verify-publish.sh .github/workflows/release.yml
git commit -m "ci: add workspace dependency verification before publish"
```

---

### Task E8: Final engineering verification

- [ ] **Step 1: Run everything**

```bash
pnpm build && pnpm test && pnpm typecheck && pnpm lint
```

- [ ] **Step 2: Commit any fixes**

```bash
git add -A && git commit -m "fix: resolve remaining engineering issues"
```

---

## Dev3: parsedBody Type Inference (Tasks T1-T8)

### Task T1: Define InferOutput utility type

**Files:**
- Modify: `packages/schema/src/standard.ts`

- [ ] **Step 1: Add InferOutput type**

The `StandardSchema` interface already has `_output: Output` phantom type. Add a utility to extract it:

```typescript
/**
 * Extract the output type from a StandardSchema or any schema with _output.
 * Falls back to unknown for unrecognized schemas.
 */
export type InferOutput<T> = T extends StandardSchema<unknown, infer O>
  ? O
  : T extends { _output: infer O }
    ? O
    : T extends { _type: infer O }  // TypeBox Static type
      ? O
      : unknown;
```

- [ ] **Step 2: Commit**

```bash
git add packages/schema/src/standard.ts
git commit -m "feat(schema): add InferOutput utility type for schema type extraction"
```

---

### Task T2: Define typed route interfaces

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Add typed route interfaces**

Add to `packages/core/src/types.ts`:

```typescript
import type { InferOutput } from "@celsian/schema/standard";

// ─── Typed Route Schema Options ───

export interface RouteSchemaOptions<
  TBody = unknown,
  TQuery = unknown,
  TParams = Record<string, string>,
> {
  schema?: {
    body?: TBody;
    querystring?: TQuery;
    params?: unknown;
  };
  onRequest?: HookHandler | HookHandler[];
  preHandler?: HookHandler | HookHandler[];
  preSerialization?: HookHandler | HookHandler[];
  onSend?: HookHandler | HookHandler[];
}

// ─── Typed Request ───

export interface TypedCelsianRequest<
  TParams = Record<string, string>,
  TBody = unknown,
  TQuery = Record<string, string | string[]>,
> extends CelsianRequest<TParams> {
  parsedBody: TBody;
  parsedQuery: TQuery;
}

// ─── Typed Handler ───

export type TypedSchemaHandler<TParams, TBody, TQuery> = (
  request: TypedCelsianRequest<TParams, TBody, TQuery>,
  reply: CelsianReply,
) => Response | unknown | Promise<Response | unknown>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(types): add TypedCelsianRequest and RouteSchemaOptions interfaces"
```

---

### Task T3: Add overloaded route method signatures

**Files:**
- Modify: `packages/core/src/app.ts`

- [ ] **Step 1: Add overloads to CelsianApp**

For each HTTP method (`get`, `post`, `put`, `patch`, `delete`), add an overload that accepts schema options. For example, for `post`:

```typescript
// Overload: with schema options (typed parsedBody)
post<T extends string, TBody = unknown, TQuery = unknown>(
  url: T,
  options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>>,
  handler: TypedSchemaHandler<
    ExtractRouteParams<T>,
    TBody extends { _output: unknown } ? InferOutput<TBody> : unknown,
    TQuery extends { _output: unknown } ? InferOutput<TQuery> : Record<string, string | string[]>
  >,
): void;
// Overload: without schema (existing API)
post<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
// Implementation
post<T extends string>(
  url: T,
  handlerOrOptions: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
  handler?: TypedSchemaHandler<unknown, unknown, unknown>,
): void {
  if (typeof handlerOrOptions === "function") {
    this.pluginContext.post(url, handlerOrOptions);
  } else {
    // Extract schema from options and register route with schema + handler
    this.pluginContext.route({
      method: "POST",
      url,
      handler: handler as TypedRouteHandler,
      schema: handlerOrOptions.schema,
      onRequest: handlerOrOptions.onRequest,
      preHandler: handlerOrOptions.preHandler,
    });
  }
}
```

Do this for all 5 HTTP methods. The `get` method typically doesn't have a body schema but should support querystring.

- [ ] **Step 2: Verify it builds**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/app.ts
git commit -m "feat(app): add overloaded route methods with schema type inference"
```

---

### Task T4: Verify params inference composes with body types

**Files:**
- Test: `packages/core/test/type-inference.test.ts` (new)

- [ ] **Step 1: Create type-level test file**

```typescript
// @celsian/core — Type inference tests
import { describe, it, expectTypeOf } from "vitest";
import { createApp } from "../src/index.js";
import { z } from "zod";

describe("route type inference", () => {
  it("should infer parsedBody type from Zod schema", () => {
    const app = createApp();
    app.post("/users", {
      schema: { body: z.object({ name: z.string(), email: z.string() }) }
    }, (req, reply) => {
      // These should be typed as string, not unknown
      expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string; email: string }>();
      return reply.json({ ok: true });
    });
  });

  it("should keep parsedBody as unknown when no schema", () => {
    const app = createApp();
    app.post("/users", (req, reply) => {
      expectTypeOf(req.parsedBody).toEqualTypeOf<unknown>();
      return reply.json({ ok: true });
    });
  });

  it("should infer params from route string", () => {
    const app = createApp();
    app.get("/users/:id", (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ ok: true });
    });
  });

  it("should infer both params and body together", () => {
    const app = createApp();
    app.put("/users/:id", {
      schema: { body: z.object({ name: z.string() }) }
    }, (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      expectTypeOf(req.parsedBody).toEqualTypeOf<{ name: string }>();
      return reply.json({ ok: true });
    });
  });
});
```

- [ ] **Step 2: Run type tests**

```bash
pnpm test -- packages/core/test/type-inference.test.ts
```

If `expectTypeOf` assertions fail, the type wiring needs fixing. Debug by checking which inference step is breaking.

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/type-inference.test.ts
git commit -m "test(types): add type-level inference tests for typed route API"
```

---

### Task T5-T6: Query inference + RPC verification

- [ ] **Step 1: Add querystring type inference tests**

Add to the type inference test file — same pattern as body but with `schema: { querystring: z.object({...}) }`.

- [ ] **Step 2: Verify RPC type inference**

Read `packages/rpc/src/procedure.ts`. The `.input()` and `.output()` methods should already chain types. Write a test confirming:

```typescript
const proc = createProcedure()
  .input(z.object({ id: z.string() }))
  .query(async ({ input }) => {
    expectTypeOf(input).toEqualTypeOf<{ id: string }>();
    return { name: "test" };
  });
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/ packages/rpc/test/
git commit -m "test(types): add query inference and RPC type verification tests"
```

---

### Task T7-T8: Update examples and templates

- [ ] **Step 1: Update all examples to use new typed API**

For each file in `examples/*/src/index.ts` that uses `req.parsedBody as { ... }`, replace with the schema options pattern:

```typescript
// Before:
app.post("/users", async (req, reply) => {
  const body = req.parsedBody as { name: string };
  ...
});

// After:
app.post("/users", {
  schema: { body: z.object({ name: z.string() }) }
}, async (req, reply) => {
  const name = req.parsedBody.name; // typed!
  ...
});
```

- [ ] **Step 2: Update all scaffolder templates**

Same transformation in `packages/create-celsian/src/templates/*.ts`.

- [ ] **Step 3: Grep for remaining casts**

```bash
grep -rn "as {" examples/ packages/create-celsian/src/templates/
grep -rn "as any" examples/ packages/create-celsian/src/templates/
```

Expected: Zero results.

- [ ] **Step 4: Run full test suite**

```bash
pnpm build && pnpm test && pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add examples/ packages/create-celsian/
git commit -m "refactor: update all examples and templates to use typed route API"
```

---

## Phase 1 Review Checklist

After merging all 3 branches:

- [ ] `pnpm install && pnpm build` — success
- [ ] `pnpm test` — all pass (709+ existing + ~50 new)
- [ ] `pnpm typecheck` — zero errors
- [ ] `pnpm lint` — zero errors
- [ ] `grep -rn "as {" examples/ packages/create-celsian/src/templates/` — zero results
- [ ] `grep -rn "workspace:" packages/*/package.json` — zero results (in dependencies)
- [ ] Spot-check S1: `.env.example` has `CORS_ORIGIN=http://localhost:3000`
- [ ] Spot-check S3: OpenAPI escapes `<script>` in title
- [ ] Spot-check S5: No stack trace without NODE_ENV

---

## Phase 2 Agent Assignments

| Agent | Branch Name | Scope |
|-------|------------|-------|
| Dev1 | `sprint/docs-benchmarks` | Tasks P1-P6 |
| Dev2 | `sprint/landing-demo` | Tasks L1-L4 |
| Dev3 | `sprint/scaffolder-cleanup` | Tasks C1-C6 |

Phase 2 tasks are less architecturally complex — primarily docs, content, and small fixes. Each agent should read the spec for their task details. The key implementation guidance:

---

### Dev1 Phase 2: JSDoc + Benchmarks (P1-P6)

**P1-P3: JSDoc** — Add `/** ... */` to every exported function/class/type in core, rpc, jwt, cache, rate-limit, compress, schema. Style: concise one-liner + `@example` for non-obvious APIs. Run `pnpm typecheck` after to ensure no JSDoc syntax errors.

**P4: Remove Fastify from benchmark table** — In `README.md`, remove the Fastify column. Keep Express (CelsianJS is 1.7x faster) and note Hono comparison at edge.

**P5: Lead with task queue story** — Rewrite README opening snippet to show `app.task()` + `app.cron()` + routes together. The current opening is a basic route handler (identical to every framework).

**P6: Per-package READMEs** — Create `README.md` in packages that lack one (core, rpc, jwt, cache, rate-limit, compress). Each: one-line description, `npm install`, 5-line example, link to main repo.

---

### Dev2 Phase 2: Landing Page + Demo (L1-L4)

**L1: Deploy landing page** — Add a `vercel.json` to `site/` with static output config. Or add a root-level vercel config that serves `site/` as a static deployment. Kirby will handle domain setup.

**L2: Update landing page benchmarks** — Match README: remove Fastify, lead with "application framework" positioning.

**L3: Build SaaS demo** — Create `examples/saas-demo/` with a single `src/index.ts` (~200-300 lines) demonstrating: JWT auth (login/register), CRUD endpoints with Zod validation, background task (send-welcome-email), cron job (nightly-report), SSE endpoint (/events), OpenAPI docs (/docs). All using the new typed route API. Include `package.json`, `tsconfig.json`, `README.md`.

**L4: Link demo** — Add "Try the demo" section to README and landing page.

---

### Dev3 Phase 2: Scaffolder + Cleanup (C1-C6)

**C1: Fix silent catch blocks** — In `packages/core/src/app.ts:394` and `packages/core/src/config.ts:48`, add `console.error('[celsian]', error)`.

**C2: Fix version pinning** — Replace hardcoded `"^0.2.0"` in templates with a dynamic version read from the package's own version.

**C3: Sanitize project name** — In `packages/create-celsian/src/index.ts:98`, reject names containing `..` and verify resolved path is a child of cwd.

**C4: Fix dev script inconsistency** — All templates should use `"dev": "npx tsx --watch src/index.ts"`.

**C5: Add CSP to Swagger UI** — Add `<meta http-equiv="Content-Security-Policy" ...>` to `swaggerHTML()`.

**C6: Fix encapsulate: false** — Verify security plugins in full template use `{ encapsulate: false }`.

---

## Phase 2 Review Checklist

- [ ] `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint` — all pass
- [ ] JSDoc renders on hover in IDE for `createApp`, `serve`, `reply.json`, `app.task`, `app.cron`
- [ ] `examples/saas-demo`: `npm install && npm run dev` starts server, `/docs` shows Swagger UI
- [ ] Landing page: `site/index.html` renders correctly, benchmarks match README
- [ ] No `as` casts in examples or templates
- [ ] Per-package READMEs exist for core, rpc, jwt, cache, rate-limit, compress

---

## Phase 3: Ship Prep

PM Agent handles (sequential, not parallel):

- [ ] **V1:** `pnpm changeset` — describe all changes (security, typed routes, engineering, docs, demo)
- [ ] **V2:** `pnpm changeset version` — bumps all packages to 0.3.0
- [ ] **V3:** `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint`
- [ ] **V4:** `pnpm -r publish --dry-run` — verify no `workspace:*`, all packages have `dist/` and `README.md`
- [ ] **V5:** Commit: `feat: v0.3.0 — security hardening, typed routes, landing page, SaaS demo`
- [ ] **V5b:** Tag: `v0.3.0` — Do NOT push or publish. Kirby decides when to ship.
