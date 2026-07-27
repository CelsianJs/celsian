---
"create-celsian": minor
"@celsian/cli": minor
---

Make the scaffolds boot, test and typecheck, and make the CLI work against a real app.

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
