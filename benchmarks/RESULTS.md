# CelsianJS Benchmark Results

**Date:** 2026-03-08 (updated after optimization pass)
**Node.js:** v22.13.1
**Platform:** macOS Darwin 25.2.0 (Apple Silicon, arm64)
**Config:** 10 connections, 10s per scenario
**Frameworks:** CelsianJS (workspace), Express 5.2.1, Fastify 5.8.1

## Results by Scenario

### 1. JSON Response (GET /json)

Simple `{ message: "Hello, World!" }` response. Measures raw framework overhead.

| Framework    |      Req/s | P50 (ms) | P99 (ms) | Throughput |
| ------------ | ---------- | -------- | -------- | ---------- |
| Fastify      |     45,866 |      0.0 |      0.0 |   8.7 MB/s |
| CelsianJS    |     27,996 |      0.0 |      0.0 |   5.8 MB/s |
| Express      |     16,321 |      0.0 |      1.0 |   3.0 MB/s |

### 2. Route Params (GET /user/:id)

Returns `{ id, name, email }` from URL param. Measures router matching + param extraction.

| Framework    |      Req/s | P50 (ms) | P99 (ms) | Throughput |
| ------------ | ---------- | -------- | -------- | ---------- |
| Fastify      |     45,440 |      0.0 |      0.0 |   9.8 MB/s |
| CelsianJS    |     27,026 |      0.0 |      0.0 |   6.3 MB/s |
| Express      |     16,288 |      0.0 |      1.0 |   4.5 MB/s |

### 3. Middleware Chain (GET /middleware, 5 layers)

5 middleware/hook layers each setting a response header, then JSON response.

| Framework    |      Req/s | P50 (ms) | P99 (ms) | Throughput |
| ------------ | ---------- | -------- | -------- | ---------- |
| Fastify      |     41,380 |      0.0 |      0.0 |  10.3 MB/s |
| CelsianJS    |     24,445 |      0.0 |      0.0 |   6.5 MB/s |
| Express      |     15,751 |      0.0 |      1.0 |   4.9 MB/s |

### 4. JSON Body Parsing (POST /echo)

Parses JSON body (`~90 bytes`) and echoes it back. Measures body parsing overhead.

| Framework    |      Req/s | P50 (ms) | P99 (ms) | Throughput |
| ------------ | ---------- | -------- | -------- | ---------- |
| Fastify      |     29,998 |      0.0 |      1.0 |   7.1 MB/s |
| CelsianJS    |     19,074 |      0.0 |      1.0 |   4.9 MB/s |
| Express      |     14,648 |      0.0 |      1.0 |   4.4 MB/s |

### 5. Error Handling (GET /error)

Route throws `new Error()`, framework catches and returns 500 JSON response.

| Framework    |      Req/s | P50 (ms) | P99 (ms) | Throughput |
| ------------ | ---------- | -------- | -------- | ---------- |
| Fastify      |     32,398 |      0.0 |      0.0 |   7.1 MB/s |
| CelsianJS    |     18,542 |      0.0 |      1.0 |  15.6 MB/s |
| Express      |     14,765 |      0.0 |      1.0 |   4.1 MB/s |

## Winner Table

| Scenario               | Winner       |      Req/s |
| ---------------------- | ------------ | ---------- |
| JSON response          | Fastify      |     45,866 |
| Route params           | Fastify      |     45,440 |
| Middleware chain (5)   | Fastify      |     41,380 |
| JSON body parsing      | Fastify      |     29,998 |
| Error handling         | Fastify      |     32,398 |

**Fastify wins every scenario** (operates directly on Node.js internals + fast-json-stringify).
**CelsianJS beats Express in all 5 scenarios** by 1.26x–1.71x.

## Relative Performance (JSON response baseline)

| Framework  | Req/s  | vs Fastify | vs Express |
| ---------- | ------ | ---------- | ---------- |
| Fastify    | 45,866 | 100%       | 2.81x      |
| CelsianJS  | 27,996 | 61%        | 1.71x      |
| Express    | 16,321 | 36%        | 1.00x      |

## Memory Usage (RSS after load)

| Framework    | RSS (MB) |
| ------------ | -------- |
| Express      |      2.5 |
| Fastify      |     17.4 |
| CelsianJS    |     94.2 |

CelsianJS uses more memory due to Web Standard `Request`/`Response` object creation per request. There is room for optimization (object pooling, reducing per-request allocations), but no memory leak — RSS is stable under sustained load.

## Optimization History

After the initial benchmark run, three critical optimizations were applied:

1. **Fixed timer leak in `Promise.race` timeout** — Each request's 30s timeout `setTimeout` was never cleared, retaining closure references. At 22K req/s this accumulated 660K+ live timer references. **Fixed with `clearTimeout` in `.finally()`.**

2. **Rewrote `buildRequest()`** — Replaced 15 getter closures with direct property assignment. Reduced per-request allocation from ~15 function objects to 6 bound methods.

3. **Optimized logger `child()`** — Replaced full `createLogger()` call per request with a lightweight inline object that reuses the parent's write function.

| Scenario | Before | After | Improvement |
|---|---|---|---|
| JSON response | 22,366 | 27,996 | **+25%** |
| Route params | 16,397 | 27,026 | **+65%** |
| Middleware chain | 13,707 | 24,445 | **+78%** |
| Body parsing | 9,255 | 19,074 | **+106%** |
| Error handling | 9,389 | 18,542 | **+97%** |
| Memory (RSS) | 7,009 MB | 94 MB | **-99%** |

## Remaining Optimization Opportunities

- Pre-compile static route handler chains (skip hook iteration for hookless routes)
- Pool/reuse CelsianRequest wrapper objects
- Stream body parsing instead of full-text-then-parse (double allocation)
- Consider fast-json-stringify for known response schemas
- Skip body-size-limit check when Content-Length is below limit
