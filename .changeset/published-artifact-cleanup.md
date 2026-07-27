---
"celsian": patch
"create-celsian": patch
"@celsian/core": patch
"@celsian/cli": patch
"@celsian/schema": patch
"@celsian/rpc": patch
"@celsian/cache": patch
"@celsian/compress": patch
"@celsian/jwt": patch
"@celsian/queue-redis": patch
"@celsian/rate-limit": patch
"@celsian/ws-redis": patch
"@celsian/adapter-bun": patch
"@celsian/adapter-cloudflare": patch
"@celsian/adapter-deno": patch
"@celsian/adapter-fly": patch
"@celsian/adapter-lambda": patch
"@celsian/adapter-node": patch
"@celsian/adapter-railway": patch
"@celsian/adapter-vercel": patch
---

Stop shipping broken source maps, and fix the `@celsian/cli` package shape.

**Source maps are no longer published.** Every package ships `files: ["dist"]`
and deliberately does not ship `src`, but the build emitted `.js.map` and
`.d.ts.map` files whose `sources` is `["../src/index.ts"]`, a path that is never
in the tarball. Consumers got a debugger that could not step into anything and a
"Go to Definition" that landed on a missing file, while the maps carried real
weight: `@celsian/core`'s tarball drops from 172.5 kB to 113.0 kB (-34.5%) with
them removed, 30.1 kB of which was `app.js.map` alone. Without a map, tooling
falls back to the emitted `.js` / `.d.ts`, which is correct rather than broken.
Shipping `src` instead would have made the maps work at the cost of roughly
doubling every tarball for a debugging affordance the project has never offered.

**`@celsian/cli` is declared as the bin-only package it is.** Its `main` and
`types` pointed at `dist/index.js`, which is the shebang'd CLI entry, so
`await import("@celsian/cli")` **executed the CLI** and printed the help banner
as a side effect of importing it. It also declared `"sideEffects": false`, which
was untrue of that same entry. `main`, `types` and `sideEffects` are removed and
no `exports` map is added: the package is consumed through its `celsian` binary,
and importing it now fails cleanly instead of running a program.

**`celsian` and `create-celsian` declare `publishConfig.access: "public"`**, the
only two publishable packages that were missing it.

**`@celsian/adapter-bun` and `@celsian/adapter-deno` widen their `@celsian/core`
peer range** from the exact current version to `>=0.5.0 <1.0.0`. An exact peer
pin meant every consumer had to match the adapter's core version to the patch,
and it also forced the release tooling to treat every minor as a breaking change
for those two packages. See `.changeset/README.md`.
