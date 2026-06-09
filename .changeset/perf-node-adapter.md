---
"@celsian/core": patch
---

Performance: faster Node request/response path (no behavior change).

- Buffered responses from `reply.json()/send()/html()` and the auto-serializer now write in a single `res.writeHead()+res.end()` with an explicit `Content-Length`, instead of draining a `ReadableStream` reader. (~+11–38% req/s across scenarios; JSON 41.4K→51.9K req/s, ~74% of Fastify.)
- `buildRequestFast()` builds the per-request wrapper from a shared prototype, eliminating 6 `.bind()` and 2 `Object.defineProperty` calls per request (~10× cheaper to construct).
- `nodeToWebRequestFast()` passes Node's header record straight to `Request` in the common all-string case.

Also: honest, isolated memory benchmark (`benchmarks/mem.ts`) replacing the previous shared-process RSS-delta measurement, which was order-biased and overstated memory ~50× for whichever framework ran first. Retained heap is on par with Express and below Fastify. Added `benchmarks/soak.ts` (sustained-load leak check). Multi-runtime serving verified on Node, Bun, Deno, Cloudflare Workers, and AWS Lambda.
