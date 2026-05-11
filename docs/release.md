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
- Use an annotated tag, for example: `git tag -a v0.3.12 -m "v0.3.12"`.
- Push the tag after confirming the GitHub release workflow did not already create it.
