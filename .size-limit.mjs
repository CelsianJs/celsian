// Bundle-size budgets for the published runtime entries (INF-04).
// Uses a .mjs config (not .json) because the dist code targets Node/edge:
// we must set esbuild platform=node + format=esm (the packages use node:
// builtins and top-level await, which the default browser/iife mode rejects).
// Adapters ignore @celsian/core so each budget tracks the adapter alone.
//
// Budgets are ~20% above sizes measured on 2026-07-26, re-baselined for the
// 0.6.0 hardening release (minified + brotli): core 58.1 kB; adapters:
// bun 948 B, cloudflare 511 B, deno 445 B, fly 1.24 kB, lambda 1.08 kB,
// node 902 B, railway 991 B, vercel 1.02 kB.
//
// Why the jump from the 2026-06-10 / 0.5.2 baseline (core 34.26 kB, bun 378 B,
// vercel 666 B): 0.6.0 added real security code to the runtime, not bloat.
// In core: file-serving root confinement with O_NOFOLLOW, redirect target
// validation, router path-alias rejection and strictParams, upload magic-byte
// sniffing plus filename sanitization, SHA-256 ETags, SSE field sanitization,
// session-bound CSRF with Sec-Fetch-Site checks, request-derived cookie Secure
// policy, the WebSocket upgrade gate (origin allow-list, hook execution,
// per-IP connection cap), the dead-letter queue with lease tokens and
// heartbeats, serverless cron detection, and lazy context-chain hook
// resolution. adapter-bun grew because its WebSocket handler
// (open/message/close/drain plus the shared upgrade gate) went from a missing
// key to a real implementation; adapter-vercel grew because
// createVercelCronHandler now actually runs cron jobs. adapter-node SHRANK
// (2.01 kB -> 902 B) because the unimplemented build adapter was removed, so
// its budget is tightened rather than left as dead headroom.
//
// Re-baseline procedure: run `pnpm size`, then set each limit ~15-20% above
// the reported figure and record the date and the reason here. Do not raise a
// budget without an entry above saying what was added.
const node = (config) => ({ ...config, platform: "node", format: "esm" });

const adapters = [
  ["adapter-bun", "1.15 KB"],
  ["adapter-cloudflare", "620 B"],
  ["adapter-deno", "540 B"],
  ["adapter-fly", "1.5 KB"],
  ["adapter-lambda", "1.3 KB"],
  ["adapter-node", "1.1 KB"],
  ["adapter-railway", "1.2 KB"],
  ["adapter-vercel", "1.25 KB"],
];

export default [
  {
    name: "@celsian/core",
    path: "packages/core/dist/index.js",
    limit: "70 KB",
    modifyEsbuildConfig: node,
  },
  ...adapters.map(([pkg, limit]) => ({
    name: `@celsian/${pkg}`,
    path: `packages/${pkg}/dist/index.js`,
    limit,
    ignore: ["@celsian/core"],
    modifyEsbuildConfig: node,
  })),
];
