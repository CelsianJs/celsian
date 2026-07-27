# Changesets

This folder holds the release notes for the next version. `changeset version`
consumes every `*.md` file here (this README is skipped) and writes the new
versions and CHANGELOGs. Add one with `pnpm changeset`.

## Why `config.json` looks the way it does

Two settings are load-bearing and easy to break, so they are explained here
rather than in the JSON (which cannot carry comments).

### `fixed`: all 20 publishable packages release in lockstep

Every published package has always carried the same version, and the
cross-package dependency ranges assume it. The `fixed` group is what enforces
that: a changeset naming one package versions all of them together.

### `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange`

Without this, **a `minor` changeset publishes 1.0.0 instead of the next 0.x
minor.** The chain:

1. `@celsian/adapter-bun` and `@celsian/adapter-deno` declare `@celsian/core` as
   a **peer** dependency.
2. Changesets bumps a peer-dependent to `major` whenever its peer gets anything
   above a patch. With this option off, that happens unconditionally.
3. The `fixed` group then raises every member to the highest release type in the
   group, so those two majors drag all 20 packages to `1.0.0`.

Measured on the 0.6.0 changeset set:

```
fixed + minor  -> 1.0.0        no fixed group + minor -> 0.6.0 for most,
fixed + patch  -> 0.5.6        but 1.0.0 for adapter-bun / adapter-deno
```

The option alone is not enough. A `workspace:*` range is resolved by changesets
to the dependency's **current exact version**, so the next minor is always "out
of range" and the major fires anyway. Both adapters therefore pin
`@celsian/core` as `workspace:>=0.5.0 <1.0.0`: pnpm still links the workspace
copy, `pnpm pack` publishes it as the plain range `>=0.5.0 <1.0.0`, and a 0.x
minor stays inside it.

**If you change either adapter's peer range back to `workspace:*` or
`workspace:^`, the next release will silently be a major.** Verify before
releasing by running `changeset version` in a throwaway `git worktree` and
printing the resulting versions:

```sh
git worktree add /tmp/cs-check HEAD --detach
cd /tmp/cs-check && ../../node_modules/.bin/changeset version
node -e 'const fs=require("fs");for(const d of fs.readdirSync("packages")){try{const p=JSON.parse(fs.readFileSync("packages/"+d+"/package.json"));if(!p.private)console.log(p.name,p.version)}catch{}}'
git worktree remove --force /tmp/cs-check && git worktree prune
```

Use the local binary. `npx changeset` fails with "could not determine executable
to run".

## Release checklist beyond the changesets

- `packages/create-celsian/src/versions.ts` -> `CELSIAN_VERSION` must be bumped
  in the release commit. A caret range on 0.x covers exactly one minor line, so
  leaving it behind makes the new scaffolder generate projects that install the
  previous release.
