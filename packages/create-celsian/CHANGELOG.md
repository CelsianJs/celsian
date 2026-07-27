# create-celsian

## 0.6.0

### Minor Changes

- 0042f48: Make the scaffolds boot, test and typecheck, and make the CLI work against a real app.

  Sprint tracks shipped these without a changeset, so none of them reached a
  generated changelog.

  **create-celsian**

  - **The `full` template could not start.** Its `cleanup` task declared
    `timeout: 30_000` against a default queue visibility timeout of `30_000`, and
    `startWorker()` rejects an equal-or-greater value, so `npm run dev`, the first
    command the generated README gives you, threw at boot. All ten generated tests
    passed anyway, because they drive the app through `app.inject()`, which never
    calls `startWorker()`. The timeout is now `15_000`, and a test asserts the
    invariant against the generated source so the template fails instead of the
    user's first run.
  - **`DELETE /users/:id` returned a 500.** It called
    `reply.status(204).json({ deleted: true })`; the `Response` constructor
    rejects a body on 204/304. It now uses `send(null)`, and a test rejects the
    `.status(204).json(` shape in every template.
  - **RPC procedures in the `full` and `rpc-api` templates did not compile.** They
    emitted the 0.5.x `procedure.input<{ name: string }>(Type.Object(...))`
    spelling, which is a TS2345 plus TS18046 against 0.6.0's re-typed
    `input<TSchema>`. They now use the inferring `procedure.input(Type.Object(...))`
    form. A new test scaffolds each template to disk and runs the real `tsc` over
    it, so a template that does not compile now fails the build rather than the
    user's.
  - **Scaffolded projects pin the current release.** The shared Celsian pin moved
    from `^0.5.0` to `^0.6.0`; `^0.5.0` does not include 0.6.0, so
    `create-celsian@0.6.0` would have generated a project installing the previous
    release.
  - Every template now ships a `test/` suite, a `test` script and a `lint`
    (`tsc --noEmit`) script, loads `.env` through `--env-file` in both `dev` and
    `start`, exports its `app` so `celsian routes` and serverless handlers can
    find it, and only calls `serve()` when the entry file is the process entry
    point, so importing it in a test no longer binds a port.
  - The scaffold no longer ships a single global rate-limit bucket or the obsolete
    CSRF workaround code.

  **@celsian/cli**

  - **`celsian dev` now loads `.env`**, the same way the scaffold's own `dev`
    script does, via Node's `--env-file` (which tsx forwards). The two previously
    diverged, so a scaffolded project run through `celsian dev` silently fell back
    to its placeholder `JWT_SECRET`. Real environment variables still win, and a
    new `--env-file <path>` flag selects a different file (a missing file that was
    asked for explicitly is now an error rather than a silent fallback).
  - **`celsian deploy` generates entrypoints that import your app.** The Vercel,
    Lambda and Cloudflare handlers previously emitted a fresh `createApp()` with a
    `// TODO: Import your routes here` comment, so deploying the generated file
    shipped an app with one health route and none of the user's. The generated
    file now imports the real app, discovered by loading the entry the same way
    `celsian routes` does, with the export style (`default` or named `app`)
    detected rather than guessed. When the entry cannot be found or loaded it
    falls back to the old conventional import and says so. It also warns when the
    entry calls `serve()` at module scope, which would start a listening server on
    every serverless cold start.
  - **`celsian build` no longer reports normal output as warnings.** esbuild emits
    `ignored-bare-import` for every side-effect-only import of a package marked
    `"sideEffects": false`, which is every Celsian package, so an ordinary build
    printed a wall of warnings that looked like failures. They are now summarised
    as a count, with `--verbose` to list them.
  - `celsian routes` and `celsian deploy` share one app-probing helper
    (`utils/app-entry.ts`) instead of `routes` carrying its own inline tsx loader
    script, and its failure modes (`no-app`, `bad-output`, load failure) are now
    distinguished in the error message.
  - `celsian --help` documents the dev options and `--verbose`, which were
    undocumented.

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

## 0.5.5

## 0.5.4

## 0.5.3

## 0.5.2

### Patch Changes

- 05eb2b4: CLI & scaffolding hardening (0.5.2 sprint, Track 4):

  - `celsian routes` works again: the loader script is written to a temp `.mts` file instead of `tsx --eval` (which compiled to CJS and always crashed on top-level await, misreported as "Could not find a CelsianApp export"). Real stderr is now propagated on load failures, the loader exits cleanly even when the entry calls `serve()`, and it binds an ephemeral port to avoid EADDRINUSE.
  - `celsian create` now reuses create-celsian's actual scaffolder (new `create-celsian` scaffold API + `workspace:*` dependency): all 4 templates (`full`, `basic`, `rest-api`, `rpc-api`) work identically from both entry points, and the stale `celsian@^0.3.18` pin is gone.
  - create-celsian refuses to scaffold into an existing non-empty directory unless `--force` is passed, and validates project names against npm package-name rules (e.g. "Bad Name!" is now rejected).
  - rest-api template: email validation uses a self-contained regex pattern instead of the unregistered TypeBox `format: 'email'` (every valid POST previously failed with 400 "Unknown format 'email'").
  - full template: CSRF `excludePaths` now lists each scaffolded RPC procedure path (core <=0.5.1 matches exactly), plus `/_rpc/*` for cores with prefix matching -- scaffolded RPC mutations no longer 403. A scaffolded test asserts the RPC mutate POST passes the full security stack.
  - full template: `.env` is scaffolded (alongside `.env.example`) and actually loaded -- dev script uses `tsx --env-file=.env --watch`, start uses `node --env-file=.env` (tsx pin bumped to `^4.16.0`). PORT/JWT_SECRET are honored now.
  - full template: dev-only `GET /auth/token` route mints a JWT for the seeded demo user; README documents the CSRF double-submit flow (the #1 beginner trap) next to the endpoint table plus a full curl recipe for the JWT-guarded routes.
  - basic/rest-api/rpc-api templates now ship `.gitignore` and a README.
  - `celsian deploy`: generated wrangler.toml gains `compatibility_flags = ["nodejs_compat"]` and a current `compatibility_date = "2026-01-01"`; the exact `npm install @celsian/adapter-<platform>` command is printed after generation; generated header comments use the correct `--platform` flag.

## 0.5.1
