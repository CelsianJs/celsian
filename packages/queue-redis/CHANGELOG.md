# @celsian/queue-redis

## 0.6.3

### Patch Changes

- Updated dependencies
  - @celsian/core@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies [4246e07]
- Updated dependencies [bc87e6e]
- Updated dependencies [d1e677e]
  - @celsian/core@0.6.2

## 0.6.1

### Patch Changes

- @celsian/core@0.6.1

## 0.6.0

### Minor Changes

- a1ef683: Make the durable task queue actually durable.

  - **Dead-letter queue.** Jobs that exhaust their retries are moved to a dead-letter queue with the final error and the full attempt history, instead of being logged and acked away. Both the in-memory and Redis backends implement `deadLetter`, `listDeadLetters`, `redriveDeadLetter`, `redriveDeadLetters`, `purgeDeadLetters` and `deadLetterSize`. New `onFailure` and `onDeadLetter` worker hooks report every failed attempt and every dead-lettered job.
  - **Atomic delayed-message promotion (Redis).** `promoteDelayed` used `pipeline()`, which batches but is not atomic, so every concurrent worker duplicated each delayed retry, and removal by score range silently deleted messages pushed into the window. It is now a single Lua script that removes by member and gates promotion on `ZREM`.
  - **Lease tokens and heartbeats.** Each delivery gets a distinct lease token; `ack`, `nack` and `extend` only affect the delivery that owns the lease, so a slow worker can no longer complete the job another worker has taken over. Tasks receive `ctx.heartbeat()` and the worker heartbeats automatically.
  - **At-least-once in-memory backend.** `MemoryQueue` reclaims and redelivers messages whose lease expires rather than losing them, and its durability limits are documented honestly in code.
  - **Task timeouts.** Tasks now default to a timeout below the queue's visibility timeout, the timer is always cleared, and a timed-out task is cancelled through `ctx.signal` instead of merely losing a race while continuing to run. Registering a task whose timeout is not below the visibility timeout throws unless `longRunning: true` is set.
  - **Loud shutdown.** A worker that hits its drain deadline reports exactly how many jobs it abandoned, on both the logger and `console.error`.
  - **Serverless cron warning.** `CronScheduler.start()` detects Cloudflare Workers, AWS Lambda, Vercel, Netlify, Deno Deploy and Cloud Run, and warns that its in-process timer will never fire there, naming the platform-native alternative.

- e75e588: Fix the public type surface exposed by turning the typecheck gate on over test files.

  **@celsian/core**

  - `CelsianRequest.cookies` is now declared. It is defined on every request by the app itself, not by a plugin, but it was reachable only through the plugin index signature, so `req.cookies.session` arrived as `unknown` and every caller had to cast.
  - The dead-letter and task-durability types are now exported: `DeadLetterCapableQueue`, `DeadLetterEntry`, `TaskFailure`, `TaskFailureInfo`, `ServerlessCronRuntime`, plus the `DEFAULT_VISIBILITY_TIMEOUT`, `DEFAULT_TASK_TIMEOUT`, and `detectServerlessCronRuntime` values. Implementing a custom queue backend previously required re-declaring them by hand.

  **@celsian/queue-redis**

  - `QueueMessage`, `TaskFailure`, and `DeadLetterEntry` are exported. `TaskFailure` and `DeadLetterEntry` were structural mirrors of core's types, kept locally only because core did not export them; they are now the real types re-exported from core, so a backend can no longer drift from the interface it implements.

  **@celsian/schema**

  - The Zod adapter accepts real Zod 4 schemas again. Its `ZodIssue.path` was declared `(string | number)[]` while Zod 4 produces `PropertyKey[]`, so `z.object(...)` did not satisfy `fromZod`'s parameter type. Symbol path segments are normalized to strings on the way out, leaving the published `SchemaIssue.path` contract unchanged.
  - `fromZod` also accepts ordinary Zod-shaped objects again. Its result type was a union discriminated on the literals `true`/`false`, which no plain function return ever has (TypeScript widens `success` to `boolean`), so only Zod's own types could satisfy it. A failed parse that carries no error object now reports that instead of throwing on a missing property.

  **@celsian/rpc**

  - `createRPCClient<any>()` is usable again. `any` satisfied every branch of the client's conditional type at once, so the result was a union of all three branches and no property access on the client compiled.

### Patch Changes

- 0042f48: Stop shipping broken source maps, and fix the `@celsian/cli` package shape.

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

- Updated dependencies [408f4af]
- Updated dependencies [a1ef683]
- Updated dependencies [509e696]
- Updated dependencies [509e696]
- Updated dependencies [1a066de]
- Updated dependencies [0042f48]
- Updated dependencies [0042f48]
- Updated dependencies [1e92ae8]
- Updated dependencies [1e92ae8]
- Updated dependencies [e75e588]
- Updated dependencies [7e85b5a]
- Updated dependencies [d668e87]
  - @celsian/core@0.6.0

## 0.5.5

### Patch Changes

- Updated dependencies [d574a13]
  - @celsian/core@0.5.5

## 0.5.4

### Patch Changes

- @celsian/core@0.5.4

## 0.5.3

### Patch Changes

- a60b3e4: Production-readiness DX fixes and dependency maintenance (0.5.3).

  - **@celsian/core (fail-loud config):** `loadConfig()` no longer swallows a broken `celsian.config.*` with a bare `catch`. A genuinely absent config still falls back to defaults, but a config that exists and fails to load (syntax/runtime error, or a missing import it depends on) now throws the new exported `ConfigLoadError` naming the file and cause. `serve()` surfaces it instead of silently binding defaults -- fixing the "why won't my config apply" black hole where a typo in the config left the server on port 3000 with no diagnostic.
  - **@celsian/cli (`celsian dev`):** checks the entry file exists before spawning `tsx`, printing `Entry file not found: <entry>` plus usage (mirroring `celsian routes`) instead of a raw "Cannot find module" stack trace on first run.
  - **@celsian/cli (`celsian generate rpc`):** now scaffolds a mountable, type-correct starting point -- wrapped in `router()`, exported as a registerable `PluginFunction` that calls `new RPCHandler(...).mount(app)`, with `.input(schema)` guidance -- instead of a bare object that had no path to a live endpoint and destructured an always-`undefined` `input`.
  - **@celsian/jwt:** bump `jose` `5.10.0` → `6.2.2` (major). No API changes; sign/verify/expiry/algorithm selection and cross-app guard isolation are all covered by the existing jwt test suite under jose 6.
  - **@celsian/ws-redis, @celsian/queue-redis:** bump `ioredis` `5.9.3` → `5.11.1` (minor).

- Updated dependencies [a60b3e4]
  - @celsian/core@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies [05eb2b4]
  - @celsian/core@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [0c69589]
  - @celsian/core@0.5.1

## 0.3.19

### Patch Changes

- Updated dependencies [dec80a7]
  - @celsian/core@0.4.0

## 0.3.16

### Patch Changes

- Updated dependencies
  - @celsian/core@0.3.16

## 0.3.1

### Patch Changes

- Updated dependencies [5d0dc35]
  - @celsian/core@0.3.3
