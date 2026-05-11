# Release checklist

Use this checklist before tagging or publishing Celsian packages.

## Pre-publish verification

- Confirm every public package manifest points to `github.com/CelsianJs/celsian` for `repository`, `homepage`, and `bugs` metadata.
- Confirm private packages such as `@celsian/platform` and `@celsian/edge-router` remain `private: true`.
- Run `pnpm build`, `pnpm typecheck`, `pnpm test`, and `pnpm verify:publish`.
- For an already-published version, run `CELSIAN_REGISTRY_VERSION=<version> pnpm verify:registry` after npm publish completes.

## Tag checklist

- Verify the changelog has an exact section for the released version.
- Tag only after npm publish and registry smoke verification pass.
- Prefer package-scoped Changesets release tags for published packages, using the package name and version, for example: `git tag -a @celsian/core@0.3.12 -m "@celsian/core@0.3.12"`.
- Create one package-scoped tag per package whose version changed in the release. Do not tag unchanged packages.
- An umbrella repository tag such as `v0.3.12` is optional and should only be added when you intentionally want a whole-repo milestone in addition to the package tags.
- Push tags after confirming the GitHub release workflow did not already create them.
