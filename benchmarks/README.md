# Benchmarks

Two kinds of measurement live here.

- **Throughput** (`run.ts`, `pnpm bench`) and **memory** (`mem.ts`): requests per second and heap
  use against Express, Fastify and Hono. Timings, so they are only meaningful on a quiet machine;
  see `RESULTS.md` for how they were taken and what they showed.
- **The per-request allocation gate** (`alloc-gate.mjs`, `pnpm test:alloc`, run in CI): counts,
  not timings. For nine kinds of request it counts the promises, timers and web objects
  (AbortController, Request, Response, Headers, ReadableStream, URL) one request costs CelsianJS on
  Node, and the young-generation GCs over 20,000 requests, and fails when a count is above its
  ceiling in `alloc-ceilings.json`. The header of `alloc-gate.mjs` explains how it counts, how to
  trace where a count comes from, and how to re-record the ceilings.

## What the allocation gate does not cover

The gate sees allocations. A change that undoes an optimisation which saved only CPU work, or
which allocated too little to move the GC total past its 10% margin, passes it. Two of the
per-request optimisations are like that, and undoing either one was measured to pass the gate:

| Optimisation | Why the gate cannot see it | Pinned instead by |
| --- | --- | --- |
| A path that is exactly a static route is matched with one map lookup, before any canonicalization (`Router.match`) | It saves a canonicalization and a second lookup, and allocates nothing either way | `packages/core/test/router-static-fast-path.test.ts`, "the exact lookup itself" |
| Route schemas are adapted once, when the route is registered, not on every request (`route-validators.ts`) | Adapting per request moved the `validated` scenario's GC total by less than its margin | `packages/core/test/route-validators.test.ts`, "are built at registration and reused by every request" |

Timing changes in general are outside the gate too: it can say a request allocates what it did,
not that it runs as fast as it did.

## `--compare`

`node benchmarks/alloc-gate.mjs --compare` runs Express, Fastify and Hono through the same
scenarios (never gated). Within a scenario every framework runs the same handler style and must
answer with the same status, the same response headers with the same values and the same body
bytes, or the run stops. Hono has no synchronous way to read a body, so it is left out of the
synchronous POST row (`body`), and the report says so. `validated` is CelsianJS only: each
framework would validate with a different library.
