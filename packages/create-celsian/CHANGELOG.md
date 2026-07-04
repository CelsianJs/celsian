# create-celsian

## 0.5.3

## 0.5.2

### Patch Changes

- 05eb2b4: CLI & scaffolding hardening (0.5.2 sprint, Track 4):

  - `celsian routes` works again: the loader script is written to a temp `.mts` file instead of `tsx --eval` (which compiled to CJS and always crashed on top-level await, misreported as "Could not find a CelsianApp export"). Real stderr is now propagated on load failures, the loader exits cleanly even when the entry calls `serve()`, and it binds an ephemeral port to avoid EADDRINUSE.
  - `celsian create` now reuses create-celsian's actual scaffolder (new `create-celsian` scaffold API + `workspace:*` dependency): all 4 templates (`full`, `basic`, `rest-api`, `rpc-api`) work identically from both entry points, and the stale `celsian@^0.3.18` pin is gone.
  - create-celsian refuses to scaffold into an existing non-empty directory unless `--force` is passed, and validates project names against npm package-name rules (e.g. "Bad Name!" is now rejected).
  - rest-api template: email validation uses a self-contained regex pattern instead of the unregistered TypeBox `format: 'email'` (every valid POST previously failed with 400 "Unknown format 'email'").
  - full template: CSRF `excludePaths` now lists each scaffolded RPC procedure path (core <=0.5.1 matches exactly), plus `/_rpc/*` for cores with prefix matching — scaffolded RPC mutations no longer 403. A scaffolded test asserts the RPC mutate POST passes the full security stack.
  - full template: `.env` is scaffolded (alongside `.env.example`) and actually loaded — dev script uses `tsx --env-file=.env --watch`, start uses `node --env-file=.env` (tsx pin bumped to `^4.16.0`). PORT/JWT_SECRET are honored now.
  - full template: dev-only `GET /auth/token` route mints a JWT for the seeded demo user; README documents the CSRF double-submit flow (the #1 beginner trap) next to the endpoint table plus a full curl recipe for the JWT-guarded routes.
  - basic/rest-api/rpc-api templates now ship `.gitignore` and a README.
  - `celsian deploy`: generated wrangler.toml gains `compatibility_flags = ["nodejs_compat"]` and a current `compatibility_date = "2026-01-01"`; the exact `npm install @celsian/adapter-<platform>` command is printed after generation; generated header comments use the correct `--platform` flag.

## 0.5.1
