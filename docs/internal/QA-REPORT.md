# CelsianJS QA Report

**Date:** 2026-02-16 (updated 2026-03-26)
**Framework Version:** 0.1.0 (bugs resolved in v0.2.0)
**Tester:** QA Engineer (automated)
**Node.js:** v22.13.1
**Runtime:** macOS Darwin 25.2.0

---

## 1. Unit Test Results

**Status: PASS (227/227)**

All 29 test files pass with 227 total tests. No failures, no flaky tests.

| Test Suite | Tests | Status |
|---|---|---|
| packages/core/test/app.test.ts | 17 | PASS |
| packages/core/test/config.test.ts | 3 | PASS |
| packages/core/test/cookie.test.ts | 12 | PASS |
| packages/core/test/cors.test.ts | 8 | PASS |
| packages/core/test/cron.test.ts | 14 | PASS |
| packages/core/test/errors.test.ts | 7 | PASS |
| packages/core/test/hooks.test.ts | 5 | PASS |
| packages/core/test/inject.test.ts | 6 | PASS |
| packages/core/test/logger.test.ts | 7 | PASS |
| packages/core/test/queue.test.ts | 7 | PASS |
| packages/core/test/reply.test.ts | 12 | PASS |
| packages/core/test/router.test.ts | 9 | PASS |
| packages/core/test/task.test.ts | 6 | PASS |
| packages/core/test/websocket.test.ts | 11 | PASS |
| packages/rpc/test/wire.test.ts | 10 | PASS |
| packages/rpc/test/client.test.ts | 7 | PASS |
| packages/rpc/test/openapi.test.ts | 4 | PASS |
| packages/rpc/test/procedure.test.ts | 8 | PASS |
| packages/rpc/test/router.test.ts | 12 | PASS |
| packages/jwt/test/jwt.test.ts | 7 | PASS |
| packages/rate-limit/test/rate-limit.test.ts | 7 | PASS |
| packages/compress/test/compress.test.ts | 8 | PASS |
| packages/schema/test/adapters.test.ts | 8 | PASS |
| packages/schema/test/coerce.test.ts | 9 | PASS |
| packages/schema/test/detect.test.ts | 5 | PASS |
| packages/schema/test/standard.test.ts | 2 | PASS |
| packages/adapter-vercel/test/vercel.test.ts | 4 | PASS |
| packages/adapter-lambda/test/lambda.test.ts | 7 | PASS |
| packages/adapter-cloudflare/test/cloudflare.test.ts | 5 | PASS |

**Duration:** 5.05s total

---

## 2. Integration Test Results

### Feature Test Summary

| Feature | Status | Notes |
|---|---|---|
| Health check / basic GET | PASS | |
| Route params (`:name`) | PASS | |
| Nested route params | PASS | |
| Query strings | PASS | |
| POST with JSON body | PASS | |
| Schema validation (TypeBox) | **FAIL** | BUG-1, BUG-2 |
| Cookie set | **FAIL** | BUG-3 (only last cookie sent) |
| Cookie read | PASS | |
| Cookie clear | PASS | |
| Cookie special chars | PASS | |
| JWT sign | **FAIL** | BUG-4 (decoration not on app instance) |
| JWT verify | PASS | (when using `getDecoration()`) |
| JWT guard (protected route) | PASS | |
| JWT invalid/missing token | PASS | |
| HTML response | PASS | |
| Redirect | PASS | |
| Streaming response | PASS | |
| Binary response | PASS | |
| Error handling (generic throw) | PASS | |
| Error handling (HttpError) | PASS | |
| Custom error hook | PASS | |
| Status codes | PASS | |
| Compression (gzip) | PASS | |
| Rate limiting | PASS | |
| Background tasks | PASS | |
| Cron scheduling | PASS | |
| RPC query (GET) | **FAIL** | BUG-2 (TypeBox require in ESM) |
| RPC mutation (POST) | **FAIL** | BUG-9 (body already consumed) |
| RPC manifest | PASS | |
| RPC non-existent procedure | PASS | |
| PUT method | PASS | |
| DELETE method | PASS | |
| PATCH method | PASS | |
| Reply chaining | PASS | |
| Custom headers | PASS | |
| CORS preflight | PASS | |
| CORS on regular requests | **FAIL** | BUG-6 (onSend headers lost) |
| Logger | PASS | |
| Route listing | PASS | |
| Plugin registration | PASS | |
| Graceful shutdown | N/A | `serve()` broken in ESM (BUG-1) |

---

## 3. Bugs Found

### BUG-1: `serve()` crashes with `require is not defined` in ESM context (CRITICAL) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P0 -- Blocks all Node.js server usage
**File:** `packages/core/src/serve.ts` lines 34-36
**Reproduction:**
```bash
cd examples/basic && npx tsx src/index.ts
# => ReferenceError: require is not defined
```

**Root Cause:** `serveNode()` uses `require('node:http')`, `require('node:fs/promises')`, and `require('node:path')` inside the function body. The package is `"type": "module"` and `tsconfig` targets ESNext modules, so the output `.js` files are ESM. `require()` is not available in ESM.

**Fix:** Replace `require()` calls with dynamic `import()`:
```ts
const http = await import('node:http');
const { readFile, stat } = await import('node:fs/promises');
const { join, extname } = await import('node:path');
```
Or convert `serveNode` to async and use top-level imports.

---

### BUG-2: TypeBox schema adapter uses `require()` in ESM (CRITICAL) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P0 -- Blocks all TypeBox schema validation
**File:** `packages/schema/src/adapters/typebox.ts` line 13
**Reproduction:**
```bash
# POST to any route with schema validation
curl -X POST http://localhost:3456/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com"}'
# => {"error":"Validation failed","statusCode":400,"issues":[{"message":"@sinclair/typebox is required for TypeBox schema validation. Install it with: npm install @sinclair/typebox"}]}
```

**Root Cause:** `fromTypeBox()` uses `require('@sinclair/typebox/value')` for lazy loading. This fails in ESM context even though `@sinclair/typebox` is installed.

**Fix:** Replace with dynamic `import()`:
```ts
Value = (await import('@sinclair/typebox/value')).Value;
```
Note: This changes `validate()` to be async, which requires propagating that change.

---

### BUG-3: Multiple Set-Cookie headers lost in Node.js response (HIGH) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P1 -- Cookie handling broken for multiple cookies
**File:** `packages/core/src/serve.ts` lines 237-239
**Reproduction:**
```ts
// Set two cookies
reply.cookie('session', 'abc', { httpOnly: true });
reply.cookie('theme', 'dark');
return reply.json({ message: 'ok' });
// Only the LAST set-cookie header appears in the HTTP response
```

**Root Cause:** `writeWebResponse()` iterates `response.headers.entries()` and calls `res.setHeader(key, value)` for each entry. When multiple `set-cookie` headers exist, each call to `setHeader` overwrites the previous value.

**Fix:** Use `response.headers.getSetCookie()` for cookies specifically, or use `res.appendHeader()`:
```ts
export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;

  // Handle set-cookie separately (multiple values)
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    res.setHeader('set-cookie', cookies);
  }

  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') continue; // Already handled
    res.setHeader(key, value);
  }
  // ... body streaming
}
```

---

### BUG-4: Plugin `decorate()` does not set property on CelsianApp instance (MEDIUM) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P2 -- Confusing API, documentation gap
**File:** `packages/core/src/app.ts` line 110-113, `packages/core/src/context.ts` line 111
**Reproduction:**
```ts
// Register JWT plugin
await app.register(jwt({ secret: 'key' }), { encapsulate: false });

// This DOES NOT work:
const jwtInstance = (app as any).jwt; // undefined

// This DOES work:
const jwtInstance = app.getDecoration('jwt'); // JWTNamespace
```

**Root Cause:** `CelsianApp.decorate()` sets both the decoration map AND a property on `this`. But when a plugin calls `app.decorate('jwt', value)` through the PluginContext interface, it only sets on the EncapsulationContext decoration map, not on the CelsianApp instance. The `Object.defineProperty(this, name, ...)` in `CelsianApp.decorate` is only triggered when called directly on the CelsianApp, not through the PluginContext.

**Fix:** Either:
1. Propagate decorations from PluginContext back to CelsianApp instance, or
2. Document that plugin decorations are only accessible via `app.getDecoration()`, or
3. Make `getDecoration()` the canonical way and remove the `Object.defineProperty` from `CelsianApp.decorate()`

---

### BUG-5: `onSend` hook headers do not apply to already-created Response (HIGH) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P1 -- CORS headers missing on all non-preflight requests
**File:** `packages/core/src/app.ts` lines 329-333
**Reproduction:**
```bash
curl -H "Origin: http://localhost:3456" http://localhost:3456/api/health
# No access-control-allow-origin header in response
```

**Root Cause:** The lifecycle in `runLifecycle()` works like this:
1. Handler runs and returns a `Response` object (line 318)
2. `preSerialization` hooks run (line 330)
3. `onSend` hooks run (line 333) -- CORS plugin sets `reply.header(...)` here
4. The `response` variable from step 1 is returned

The headers set on `reply` during `onSend` hooks are never applied to the `Response` object created in step 1. The `reply` object tracks headers separately, but those headers are only used when `reply.json()`, `reply.send()`, etc. build a NEW Response. Since the Response was already created by the handler, the onSend modifications are lost.

**Fix:** After onSend hooks run, merge `reply.headers` into the response:
```ts
// After onSend hooks
const finalHeaders = new Headers(response.headers);
for (const [key, value] of Object.entries(reply.headers)) {
  finalHeaders.set(key, value);
}
// Rebuild response with merged headers if reply.headers were modified
if (Object.keys(reply.headers).length > 0) {
  response = new Response(response.body, {
    status: response.status,
    headers: finalHeaders,
  });
}
```

---

### BUG-6: CORS headers missing on non-preflight requests (HIGH) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint (fixed via BUG-5 fix)
**Severity:** P1 -- CORS completely broken for actual API calls
**Depends on:** BUG-5

The CORS plugin registers an `onSend` hook to add `access-control-allow-origin` and other headers to regular (non-OPTIONS) responses. Due to BUG-5, these headers are never applied.

**Impact:** Frontend applications making cross-origin requests will see preflight succeed (OPTIONS returns correct headers) but actual requests will be blocked by the browser due to missing CORS headers.

---

### BUG-7: Router returns 404 instead of 405 for wrong HTTP method (LOW) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P3 -- Incorrect HTTP semantics
**File:** `packages/core/src/router.ts` line 88, `packages/core/src/app.ts` lines 216-222
**Reproduction:**
```bash
curl -X POST http://localhost:3456/api/health
# => 404 Not Found (should be 405 Method Not Allowed)
```

**Root Cause:** The router's `match()` method returns `null` when the method doesn't match, even though the URL path exists. The app treats `null` as "not found" and returns 404. Per RFC 7231, a 405 response with an `Allow` header should be returned.

**Fix:** Have `match()` differentiate between "path not found" and "method not allowed". Return method-not-allowed info so the app can respond with 405 and an `Allow: GET, HEAD` header.

---

### BUG-8: HEAD requests return 404 (LOW) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P3 -- Incorrect HTTP semantics
**File:** `packages/core/src/router.ts`
**Reproduction:**
```bash
curl -X HEAD http://localhost:3456/api/health
# => 404 Not Found (should be 200 with no body)
```

**Root Cause:** The router has no automatic HEAD-to-GET fallback. Per HTTP spec, HEAD should behave identically to GET but without the response body.

**Fix:** In the router's `match()`, if `method === 'HEAD'` and no explicit HEAD route exists, fall back to the GET route.

---

### BUG-9: RPC POST body already consumed by app body parser (HIGH) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P1 -- RPC mutations completely broken when using CelsianJS routes
**File:** `packages/rpc/src/router.ts` line 99, `packages/core/src/app.ts` line 302
**Reproduction:**
```bash
curl -X POST http://localhost:3456/_rpc/math.add \
  -H "Content-Type: application/json" -d '{"a":3,"b":4}'
# => {"error":{"message":"Invalid JSON body","code":"PARSE_ERROR"}}
```

**Root Cause:** The CelsianJS request lifecycle calls `parseBody()` in step 3 (line 302 of `app.ts`), which reads the request body stream via `request.json()`. Later, the RPC handler tries to read the body again with `request.json()` (line 99 of `router.ts`), but the body stream has already been consumed.

**Fix:** The RPC handler should use `request.parsedBody` (the pre-parsed body from CelsianJS) instead of `request.json()`:
```ts
// In RPCHandler.handle():
if (request.method === 'POST') {
  // Use CelsianJS pre-parsed body if available
  const celsianReq = request as any;
  if (celsianReq.parsedBody !== undefined) {
    rawInput = decode(celsianReq.parsedBody);
  } else {
    rawInput = decode(await request.json());
  }
}
```

---

### BUG-10: Malformed JSON body silently returns 200 (LOW) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P3 -- Could mask errors
**File:** `packages/core/src/app.ts` lines 378-388
**Reproduction:**
```bash
curl -X POST http://localhost:3456/api/echo \
  -H "Content-Type: application/json" -d '{broken json'
# => {} (HTTP 200)
```

**Root Cause:** `parseBody()` has a `try/catch` that silently swallows JSON parse errors, leaving `parsedBody` as `undefined`. The handler then returns `{ received: undefined }` which serializes to `{}`.

**Impact:** Clients sending malformed JSON get a 200 OK with empty data instead of a 400 error. This makes debugging difficult.

**Recommendation:** Consider throwing a `ValidationError` or `HttpError(400)` when body parsing fails for a declared content-type. At minimum, set `parsedBody = null` to distinguish "no body" from "parse error".

---

### BUG-11: Path params not URL-decoded (LOW) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P3
**File:** `packages/core/src/router.ts` line 129, `packages/core/src/request.ts`
**Reproduction:**
```bash
curl http://localhost:3456/api/hello/%E4%B8%96%E7%95%8C
# => {"message":"Hello, %E4%B8%96%E7%95%8C!"} (should decode to Chinese characters)

curl http://localhost:3456/api/hello/a%2Fb
# => {"message":"Hello, a%2Fb!"} (should be "a/b")
```

**Root Cause:** `splitPath()` splits on `/` but does not `decodeURIComponent()` the segments. URL.pathname preserves percent-encoding.

**Fix:** Apply `decodeURIComponent()` to param values in `matchNode()` when assigning to params:
```ts
params[node.paramName] = decodeURIComponent(seg);
```

---

### BUG-12: CORS preflight returns allow-methods/headers for disallowed origins (LOW) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P3
**File:** `packages/core/src/plugins/cors.ts` lines 48-76
**Reproduction:**
```bash
curl -X OPTIONS http://localhost:3456/api/health \
  -H "Origin: http://evil.com" \
  -H "Access-Control-Request-Method: POST"
# Returns 204 with access-control-allow-methods and access-control-allow-headers
# but WITHOUT access-control-allow-origin
```

**Root Cause:** The preflight handler always sets `allow-methods` and `allow-headers` regardless of whether the origin is allowed. Only the `allow-origin` header is conditionally set.

**Impact:** While browsers will still block the request (no `allow-origin`), it leaks information about allowed methods and headers to unauthorized origins.

**Fix:** Skip all CORS headers when origin is not allowed, or return 403.

---

### BUG-13: Duplicate query params only keep last value (LOW) -- RESOLVED

**Status:** RESOLVED in v0.2.0 hardening sprint
**Severity:** P3 -- Design decision, but undocumented
**File:** `packages/core/src/request.ts` lines 10-13
**Reproduction:**
```bash
curl "http://localhost:3456/api/search?tag=a&tag=b&tag=c"
# => {"query":{"tag":"c"}} (only last value kept)
```

**Root Cause:** The query parser iterates `url.searchParams` and assigns to a plain object, so duplicate keys get overwritten by the last value.

**Recommendation:** Either:
1. Document this behavior clearly
2. Support arrays: `tag: ["a", "b", "c"]`
3. Use `url.searchParams.getAll(key)` for array support

---

## 4. Performance Results

### Benchmark: `/api/health` (simple JSON GET, no plugins)

```
Node.js v22.13.1, macOS, 100 concurrent connections, 10 seconds

Requests/sec: 25,381 (avg), 32,511 (p97.5)
Latency p50:  2ms
Latency p99:  9ms
Latency max:  649ms
Total:        254,000 requests in 10s
Throughput:   6.17 MB/s
```

**Assessment:** Good performance for a Node.js framework with Web Request/Response conversion overhead. The p50 latency of 2ms is competitive. The p99 spike to 9ms and max to 649ms suggest occasional GC pauses.

### Benchmark: with rate limiting + CORS + compression + JWT + logging plugins

```
Rate limiting causes most requests to return 429 after first 50.
Only 29/178,394 requests returned 2xx.
Actual throughput: ~17,841 req/sec (though most are 429 responses)
```

**Note:** Rate limiting performance is correct -- the plugin efficiently rejects excess requests.

---

## 5. Deployment Test Results (Vercel Edge)

**Endpoint:** `https://vercel-edge-ten-rho.vercel.app`

| Test | Status | Response Time |
|---|---|---|
| GET /api/health | PASS (200) | 149-212ms |
| GET /api/hello/TestUser | PASS (200) | ~170ms |
| GET /api/routes | PASS (200) | ~170ms |
| POST /api/echo (JSON body) | PASS (200) | ~150ms |
| OPTIONS preflight | PASS (204) | ~150ms |
| GET /api/nonexistent | PASS (404) | ~150ms |
| DELETE /api/health | 404 | Same BUG-7 as local |
| Cold start | N/A | ~150-212ms (includes network) |

**Assessment:** The Vercel Edge deployment works well. Response times are consistently low (150-212ms including network latency from test location). The Edge runtime avoids the `require()` bugs since it uses Web Standard APIs natively.

---

## 6. Feature Area Summary

| Area | Status | Bugs |
|---|---|---|
| Core Router | **PASS** (with issues) | BUG-7, BUG-8, BUG-11 |
| Request/Reply | **PASS** | |
| Hook Lifecycle | **FAIL** | BUG-5 (onSend headers lost) |
| Plugin System | **PASS** (with issues) | BUG-4 (decoration access) |
| CORS Plugin | **FAIL** | BUG-5, BUG-6, BUG-12 |
| JWT Plugin | **PASS** (with workaround) | BUG-4 |
| Rate Limiting | **PASS** | |
| Compression | **PASS** | |
| Schema Validation | **FAIL** | BUG-2 |
| RPC System | **FAIL** | BUG-2, BUG-9 |
| Background Tasks | **PASS** | |
| Cron Scheduling | **PASS** | |
| Cookie Handling | **FAIL** | BUG-3 |
| Error Handling | **PASS** | BUG-10 (silent parse fail) |
| Logger | **PASS** | |
| `serve()` Function | **FAIL** | BUG-1 |
| Vercel Edge Adapter | **PASS** | |
| Lambda Adapter | **PASS** (unit tests) | |
| Cloudflare Adapter | **PASS** (unit tests) | |
| `inject()` Test Utility | **PASS** | |

---

## 7. Recommendations

### Must Fix Before Release (P0/P1)

1. **BUG-1:** Replace `require()` with `import()` in `serve.ts`. This is the primary entry point for Node.js users and it is completely broken.

2. **BUG-2:** Replace `require()` with `import()` in `typebox.ts` adapter. Schema validation is a core feature and does not work at all.

3. **BUG-3:** Fix `writeWebResponse()` to handle multiple `set-cookie` headers. Use `response.headers.getSetCookie()` or `res.appendHeader()`.

4. **BUG-5/BUG-6:** Fix the `onSend` hook to actually merge headers into the Response. CORS is entirely non-functional for real browser requests. This is the most architecturally significant bug -- the `onSend` hook modifies `reply.headers` but those are never applied to the already-created `Response` object.

5. **BUG-9:** Fix RPC handler to use `request.parsedBody` when available, since the body stream has already been consumed by the app lifecycle.

### Should Fix (P2)

6. **BUG-4:** Clarify the decoration API. Either propagate plugin decorations to the app instance or document `getDecoration()` as the canonical access pattern.

7. **BUG-8:** Add automatic HEAD-to-GET fallback in the router per HTTP spec.

### Nice to Have (P3)

8. **BUG-7:** Return 405 with `Allow` header for method mismatches.
9. **BUG-10:** Consider throwing on malformed JSON body parse instead of silently swallowing.
10. **BUG-11:** Add `decodeURIComponent()` for path params.
11. **BUG-12:** Skip all CORS headers for disallowed origins.
12. **BUG-13:** Document or fix duplicate query param behavior.

### Testing Gaps

- **WebSocket support** has unit tests but was not integration-tested (requires a WS client).
- **Multi-runtime support** (Bun, Deno) was not tested. The `serve()` has runtime detection but only Node.js was verified.
- **Config file loading** (`loadConfig()`) was not integration-tested.
- **Plugin encapsulation** (nested contexts, prefix isolation) needs more edge case testing.
- **Static file serving** in `serve()` was not tested due to BUG-1.

### Architecture Notes

- The fundamental issue with BUG-5 (onSend headers lost) suggests a design tension: hooks modify `reply`, but the `Response` object is immutable once created. The lifecycle needs a clear contract about when Response headers can be modified.
- The `require()` usage in ESM (BUG-1, BUG-2) suggests the project was developed in a CJS-compatible environment (possibly Bun or Vitest which polyfill `require`). All lazy `require()` calls should be converted to dynamic `import()`.
- The RPC body consumption issue (BUG-9) reveals a coupling problem: the RPC handler assumes it receives a raw Request, but the CelsianJS lifecycle pre-processes the body. Either the RPC handler should be lifecycle-aware, or there should be a way to skip body parsing for specific routes.

---

## 8. Test Artifacts

- **QA test app:** `/Users/macbookpro-kirby/Desktop/Coding/celsian/examples/qa-test/src/index.ts`
- **Benchmark app:** `/Users/macbookpro-kirby/Desktop/Coding/celsian/examples/qa-test/src/bench.ts`
- **This report:** `/Users/macbookpro-kirby/Desktop/Coding/celsian/QA-REPORT.md`

---

## 9. v0.2.0 Resolution Summary

All 13 bugs identified in the initial QA report have been resolved in the v0.2.0 hardening sprint:

| Bug | Severity | Status |
|-----|----------|--------|
| BUG-1 | P0 (CRITICAL) | RESOLVED -- replaced require() with dynamic import() |
| BUG-2 | P0 (CRITICAL) | RESOLVED -- replaced require() with dynamic import() |
| BUG-3 | P1 (HIGH) | RESOLVED -- fixed Set-Cookie header handling |
| BUG-4 | P2 (MEDIUM) | RESOLVED -- propagated plugin decorations |
| BUG-5 | P1 (HIGH) | RESOLVED -- onSend headers merged into Response |
| BUG-6 | P1 (HIGH) | RESOLVED -- fixed via BUG-5 fix |
| BUG-7 | P3 (LOW) | RESOLVED -- router returns 405 with Allow header |
| BUG-8 | P3 (LOW) | RESOLVED -- HEAD-to-GET fallback added |
| BUG-9 | P1 (HIGH) | RESOLVED -- RPC uses parsedBody when available |
| BUG-10 | P3 (LOW) | RESOLVED -- malformed JSON returns 400 |
| BUG-11 | P3 (LOW) | RESOLVED -- decodeURIComponent() applied to params |
| BUG-12 | P3 (LOW) | RESOLVED -- CORS skips headers for disallowed origins |
| BUG-13 | P3 (LOW) | RESOLVED -- duplicate query params now produce arrays |
