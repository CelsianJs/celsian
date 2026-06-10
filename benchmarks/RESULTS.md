# CelsianJS Benchmark Results

**Date:** 2026-06-08 (post 0.5.x performance pass)
**Node.js:** v22.13.1
**Platform:** macOS Darwin (Apple Silicon, arm64)
**Config:** 10 connections, 10s per scenario
**Frameworks:** CelsianJS (workspace), Express 5.x, Fastify 5.x

> Reproduce: `npx tsx benchmarks/run.ts` (throughput) and
> `for fw in celsian express fastify; do NODE_OPTIONS=--expose-gc npx tsx benchmarks/mem.ts $fw; done` (memory).

## Throughput by Scenario

| Scenario             | Fastify | CelsianJS | Express | Celsian vs Express | Celsian vs Fastify |
| -------------------- | ------: | --------: | ------: | -----------------: | -----------------: |
| JSON response        |  69,681 |    51,897 |  22,775 |             2.28×  |              74%   |
| Route params         |  69,075 |    50,790 |  22,713 |             2.24×  |              74%   |
| Middleware chain (5) |  64,826 |    45,028 |  22,248 |             2.02×  |              69%   |
| JSON body parsing    |  43,824 |    35,488 |  20,217 |             1.76×  |              81%   |
| Error handling       |  47,818 |    26,061 |  20,795 |             1.25×  |              55%   |

**Fastify wins every scenario** (it operates directly on Node `req`/`res` + `fast-json-stringify`).
**CelsianJS beats Express in all 5 scenarios** by **1.25×–2.28×**. The gap to Fastify is the cost
of the Web Standard `Request`/`Response` round-trip on Node — the tradeoff for multi-runtime portability.

## Memory Usage (honest, isolated)

Each framework runs in its **own fresh process**, driven by an **external** autocannon client (so the
load generator's memory is not counted), then RSS/heap are read after GC. This is the apples-to-apples
number — see the correction below about the old, misleading figure.

| Framework | RSS (MB) | Heap used (MB) |
| --------- | -------: | -------------: |
| CelsianJS |    187.6 |           13.9 |
| Express   |    173.0 |           12.8 |
| Fastify   |    122.8 |           16.3 |

CelsianJS's **retained heap (13.9 MB) is on par with Express (12.8 MB) and lower than Fastify (16.3 MB)**.
RSS is within ~8% of Express. There is no memory problem.

> ⚠️ **Correction.** Earlier results reported CelsianJS at ~94 MB vs "2.5 MB" for Express. That was a
> **measurement artifact**, not real usage: `run.ts` hosted all three servers in a single shared process
> and reported per-framework RSS *deltas*. Whichever framework ran first (CelsianJS) absorbed the entire
> one-time process warm-up — V8 heap growth, JIT, and autocannon's connection pools — while the others,
> running into an already-grown heap, showed impossibly small deltas (an absolute RSS of "2.5 MB" is below
> Node's ~40 MB floor). The throughput numbers were always valid; only the memory table was wrong.
> Memory is now measured by `benchmarks/mem.ts` in isolated processes.

## 0.5.x Performance Pass — What Changed

Throughput improvements vs the pre-pass 0.5.0 baseline (same machine):

| Scenario          | Before | After  | Improvement |
| ----------------- | -----: | -----: | ----------: |
| JSON response     | 41,433 | 51,897 |       +25%  |
| Route params      | 41,773 | 50,790 |       +22%  |
| Middleware chain  | 38,925 | 45,028 |       +16%  |
| JSON body parsing | 32,003 | 35,488 |       +11%  |
| Error handling    | 18,948 | 26,061 |       +38%  |

Three changes, all at the Node adapter boundary (the core lifecycle was already fast — ~245K ops/s in-process):

1. **Fast buffered response write.** `reply.json()/send()/html()` and the auto-serializer tag the Response
   with their already-serialized body + plain headers (`fast-response.ts`). The Node writer emits it in a
   single `res.writeHead() + res.end(body)` with an explicit `Content-Length` — skipping the
   `response.body.getReader()` stream drain, the second socket write, and chunked encoding.
2. **Prototype-based request wrapper.** `buildRequestFast()` builds the per-request object from a shared
   prototype whose body methods/accessors delegate to the source Request — eliminating 6 `.bind()` calls and
   2 `Object.defineProperty` calls per request (~10× cheaper to construct: 357 ns → 36 ns).
3. **Single Headers build at the boundary.** `nodeToWebRequestFast()` passes Node's header record straight to
   the `Request` constructor in the common (all-string) case instead of building an intermediate `Headers`.

## Remaining Optimization Opportunities

- Lightweight/lazy `Request` (defer header + URL materialization) — the largest remaining gap to Fastify.
- `fast-json-stringify` for routes with a declared response schema.
- Stream body parsing instead of read-full-text-then-parse (avoids double allocation on POST).
- Fast-path the error response through `fast-response.ts` (error handling is the weakest scenario).
