# CelsianJS Performance Roadmap

**Constraint**: CelsianJS is a hybrid framework — Node.js, Bun, Deno, Cloudflare Workers, AWS Lambda, Vercel Edge. Every optimization MUST work across all runtimes. If an optimization only helps Node.js, it must be gated behind runtime detection and fall back to the universal path on other runtimes.

## Current State (v0.2.0)

| Scenario | Fastify | CelsianJS | Express | CelsianJS vs Fastify |
|----------|--------:|----------:|--------:|---------------------:|
| JSON response | 45,866 | 27,996 | 16,321 | 61% |
| Route params | 45,440 | 27,026 | 16,288 | 60% |
| Middleware (5) | 41,380 | 24,445 | 15,751 | 59% |
| JSON body parsing | 29,998 | 19,074 | 14,648 | 64% |
| Error handling | 32,398 | 18,542 | 14,765 | 57% |

Memory: CelsianJS 94MB RSS vs Fastify 17MB vs Express 2.5MB

## Why CelsianJS Is Slower

### 1. Web Standard API overhead (~40% of the gap)

CelsianJS creates `new Request()` and `new Response()` per HTTP request. Fastify operates directly on Node.js `IncomingMessage`/`ServerResponse` — raw C++ bindings with zero wrapping cost.

This is the fundamental trade-off for multi-runtime support. Workers, Lambda, Deno, and Vercel Edge all speak Web Standard APIs natively — the Request/Response model is zero-cost there. The overhead only exists on Node.js where we bridge from `http.IncomingMessage` to `Request`.

### 2. No pre-compiled JSON serialization (~20% of the gap)

Fastify uses `fast-json-stringify` to generate optimized serializers from route schemas at registration time. Instead of generic `JSON.stringify(obj)`, it generates code like:
```js
function serialize(obj) { return '{"name":"' + obj.name + '","age":' + obj.age + '}'; }
```
This is 2-5x faster than `JSON.stringify` for known shapes.

### 3. Per-request memory allocation (~15% of the gap)

`buildRequestFast()` creates a fresh `CelsianRequest` object per request via `Object.create(null)` with direct property assignment. Fastify pools and reuses request/reply objects, reducing GC pressure.

### 4. Hook iteration overhead (~5% of the gap)

Hooks are checked with `.length > 0` guards (good), but when hooks exist, they run through an async loop with `Promise` wrapping. Fastify pre-compiles hook chains into direct function calls at registration time.

## Optimization Plan

### Phase 1: Node.js Fast Path (target: +30-40%)

**Approach**: On Node.js, bypass `Request` creation for the hot path. Use a lightweight internal request representation that stays compatible with the handler API.

```typescript
// Runtime detection already exists in serve.ts
if (isNodeJS) {
  // Fast path: extract method, url, headers directly from IncomingMessage
  // Only create full Request if handler actually reads .body or other Request-specific APIs
  // Use lazy Request creation via Proxy or getter
}
```

**Multi-runtime safe**: Workers/Lambda/Deno already receive native `Request` — no change needed. This optimization only activates on Node.js via the existing runtime detection in `serve.ts`.

**Risk**: Low. The `CelsianRequest` interface is the contract — as long as it's satisfied, the underlying implementation can vary by runtime.

### Phase 2: Response Schema Serialization (target: +15-20%)

**Approach**: When a route defines `schema.response`, pre-compile a JSON serializer at registration time.

```typescript
app.get('/users/:id', {
  schema: {
    response: z.object({ id: z.string(), name: z.string(), email: z.string() })
  }
}, handler);
// At registration: compile a fast serializer from the response schema
// At request time: use the compiled serializer instead of JSON.stringify
```

**Multi-runtime safe**: JSON serialization is pure JS — works identically on all runtimes. `fast-json-stringify` or a custom implementation would be a devDependency used at registration time, not a runtime dependency.

**Risk**: Medium. Need to handle cases where the actual response doesn't match the schema (fallback to `JSON.stringify`). Must not break when no response schema is defined.

### Phase 3: Request Object Pooling (target: +10-15%)

**Approach**: Pool `CelsianRequest` wrapper objects and reset them between requests instead of creating new ones.

```typescript
const requestPool: CelsianRequest[] = [];

function acquireRequest(): CelsianRequest {
  return requestPool.pop() ?? Object.create(null);
}

function releaseRequest(req: CelsianRequest): void {
  // Clear all properties
  for (const key of Object.keys(req)) delete req[key];
  if (requestPool.length < 256) requestPool.push(req);
}
```

**Multi-runtime safe**: Object pooling is pure JS. Works on all runtimes.

**Risk**: Medium. Must ensure requests are fully cleaned between reuse (no data leaks between requests). Must handle concurrent requests correctly. Serverless (Lambda, Workers) may not benefit since each invocation is often a fresh context.

### Phase 4: Hook Chain Compilation (target: +5%)

**Approach**: At route registration time, compile the hook chain into a single function instead of iterating an array at request time.

```typescript
// Instead of:
for (const hook of route.hooks.preHandler) {
  const result = await hook(request, reply);
  if (result instanceof Response) return result;
}

// Compile to:
const runPreHandler = compileHookChain(route.hooks.preHandler);
// Generates: async (req, reply) => { let r; r = await h1(req,reply); if(r) return r; r = await h2(req,reply); if(r) return r; }
```

**Multi-runtime safe**: Function compilation via `new Function()` is available on all runtimes EXCEPT Cloudflare Workers (which blocks `eval`/`new Function` by default). Must use a fallback to the array iteration path on Workers.

**Risk**: High. `new Function()` is a security-sensitive API. Some environments (Workers, CSP-strict) block it. Must feature-detect and fall back gracefully. Consider whether the 5% gain justifies the complexity.

**Alternative**: Skip `new Function()` entirely. Instead, pre-build a closure chain at registration time:
```typescript
function compileHookChain(hooks: HookHandler[]): HookHandler {
  if (hooks.length === 0) return noopHook;
  if (hooks.length === 1) return hooks[0];
  if (hooks.length === 2) return async (req, reply) => {
    const r1 = await hooks[0](req, reply);
    if (r1 instanceof Response) return r1;
    return hooks[1](req, reply);
  };
  // General case: reduce to nested closures
  return hooks.reduceRight((next, hook) => async (req, reply) => {
    const r = await hook(req, reply);
    if (r instanceof Response) return r;
    return next(req, reply);
  });
}
```
This is multi-runtime safe (no eval), avoids the array iteration overhead, and is simpler.

## Projected Performance After All Phases

| Scenario | Current | Target | vs Fastify |
|----------|--------:|-------:|-----------:|
| JSON response | 27,996 | ~40,000 | ~87% |
| Route params | 27,026 | ~38,000 | ~84% |
| Middleware (5) | 24,445 | ~34,000 | ~82% |
| JSON body parsing | 19,074 | ~27,000 | ~90% |
| Error handling | 18,542 | ~26,000 | ~80% |

**Realistic ceiling**: ~85-90% of Fastify on Node.js. Getting to 100% would require abandoning Web Standard APIs, which breaks the multi-runtime promise.

**On Workers/Lambda/Deno**: CelsianJS should be competitive or faster than Fastify's Node adapter since Web Standard APIs are native on those platforms (zero bridging cost).

## What NOT To Do

1. **Don't fork the API by runtime.** Handlers must work identically everywhere. Optimizations live in the internal plumbing, not the public API.
2. **Don't add `fast-json-stringify` as a runtime dependency.** It's a Node.js-specific package. Use it as an optional optimization that's detected at build time.
3. **Don't use `eval` or `new Function`.** Blocked on Workers, security risk, marginal gain. Use closure compilation instead.
4. **Don't break the Request/Response contract.** Even if we bypass `Request` creation internally on Node.js, anything exposed to user code must conform to the Web Standard API interface.
5. **Don't optimize at the cost of correctness.** Object pooling with data leaks between requests is worse than being slow.

## Priority Order

1. **Phase 2 (Response Schema Serialization)** — highest ROI, lowest risk, multi-runtime safe, builds on existing schema infrastructure
2. **Phase 1 (Node.js Fast Path)** — biggest gain but more complex, Node-only optimization
3. **Phase 3 (Request Pooling)** — medium gain, medium risk, mainly benefits long-running Node/Bun servers (not serverless)
4. **Phase 4 (Hook Compilation)** — smallest gain, use closure approach not eval
