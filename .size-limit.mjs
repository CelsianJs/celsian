// Bundle-size budgets for the published runtime entries (INF-04).
// Uses a .mjs config (not .json) because the dist code targets Node/edge:
// we must set esbuild platform=node + format=esm (the packages use node:
// builtins and top-level await, which the default browser/iife mode rejects).
// Adapters ignore @celsian/core so each budget tracks the adapter alone.
//
// Budgets are ~20% above sizes measured on 2026-06-10 after the 0.5.2
// hardening sprint (minified + brotli): core 34.26 kB; adapters: bun 378 B,
// cloudflare 511 B (+scheduled bridge), deno 386 B, fly 1.25 kB,
// lambda 1.08 kB (+APIGW v1/ALB support), node 2.01 kB, railway 991 B,
// vercel 666 B.
const node = (config) => ({ ...config, platform: "node", format: "esm" });

const adapters = [
  ["adapter-bun", "460 B"],
  ["adapter-cloudflare", "640 B"],
  ["adapter-deno", "470 B"],
  ["adapter-fly", "1.5 KB"],
  ["adapter-lambda", "1.3 KB"],
  ["adapter-node", "2.5 KB"],
  ["adapter-railway", "1.2 KB"],
  ["adapter-vercel", "720 B"],
];

export default [
  {
    name: "@celsian/core",
    path: "packages/core/dist/index.js",
    limit: "40 KB",
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
