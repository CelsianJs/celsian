# Releasing CelsianJS

CelsianJS releases use Changesets and GitHub Actions. Do not publish from a local
dirty worktree.

## Release Path

1. Feature PRs include a Changeset for every affected public package.
2. PR CI must pass: build, tests, typecheck, lint/release-surface checks, and package smoke.
3. Merging to `main` lets the Changesets action create or update the version PR.
4. Review and merge the Changesets version PR.
5. `.github/workflows/release.yml` publishes via `pnpm release` with npm provenance enabled.
6. When packages are published, the workflow runs `pnpm verify:registry` and uploads
   `artifacts/registry-smoke.json`.

## Local Pre-Release Gate

Use the repo-pinned package manager:

```sh
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm verify:publish
pnpm audit:release
```

CI pins npm 11.16.0 for packed-consumer verification and publishing. Older npm
versions can crash internally with `Cannot read properties of null (reading
'edgesOut')` when resolving the smoke fixtures' local tarball overrides. If this
occurs locally, use npm 11.16.0 with Node 22.9+ (or Node 20.17+); do not skip the
packed-consumer gate. This tooling pin does not change package runtime support.

## Post-Publish Verification

The release workflow runs:

```sh
pnpm verify:registry
```

This installs the published packages into a clean consumer, imports public
packages, checks CLI bins, scaffolds generated apps, and builds/health-checks the
templates that should boot.

Fresh npm publishes can return transient `ETARGET`/`404` responses while
registry metadata propagates. The verifier retries only those registry lookup
failures, uses a fresh per-run npm cache with online metadata flags, and uploads
a success or failure artifact with bounded attempt logs.

If publishing already succeeded and only the registry smoke needs to be rerun,
use the manual `Verify registry packages` workflow. Provide the exact published
semver version in the `version` input, without a leading `v`. That workflow has
no npm token and does not publish; it only runs the registry consumer smoke for
the immutable version already on npm.

## Rules

- Vura Platform/private code is never part of this release.
- Do not paste npm tokens into commands, docs, PRs, or logs.
- If publish succeeds but a later verification fails, do not unpublish or rewrite
  history casually; fix forward with a new patch release when package contents need
  to change.
