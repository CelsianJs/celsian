# Release Plan — CelsianJS 0.5.0 (production-hardening, 2026-06-07)

This branch (`hardening/production-2026-06-07`) unifies **all 20 public packages onto `0.5.0`**
and configures changesets `fixed` so versions can never drift again. All gates are green locally.

## What's already done on the branch
- All 20 public `package.json` set to `0.5.0` (incl. `@celsian/adapter-bun`/`-deno`, intentionally
  brought down from the mistaken `1.0.0`).
- `.changeset/config.json` → single `fixed` group of all 20 public packages (empty `linked`).
- `create-celsian` templates pin `^0.5.0` (centralized in `src/versions.ts`).
- Root `CHANGELOG.md` has the `0.5.0` section. No changeset file is left (manual version), so the
  CI `changesets/action` will run the **publish** path (`pnpm release`) on merge — not re-version.
- Gates: `build` ✓ · `typecheck` ✓ · `lint:ci` ✓ · `test` ✓ · `verify:publish` ✓.

## Release steps (you run these — npm publish is irreversible)

1. **Merge the PR to `main`.** The `Release` workflow runs `verify` then `changesets/action`,
   which (no changesets present) executes `pnpm release` = `changeset publish --provenance`,
   publishing every package whose version isn't yet on npm → all 20 at `0.5.0`.
   - Requires `NPM_TOKEN` secret (already wired in `.github/workflows/release.yml`).

2. **Deprecate the mistaken adapter `1.0.0` publishes** (they otherwise sit "above" 0.5.0 as a
   higher semver and confuse `@latest`/`*` resolvers). After 0.5.0 is live:
   ```bash
   npm deprecate @celsian/adapter-bun@1.0.0  "Published in error. Use ^0.5.0 (unified Celsian release line)."
   npm deprecate @celsian/adapter-deno@1.0.0 "Published in error. Use ^0.5.0 (unified Celsian release line)."
   # Confirm latest points at 0.5.0:
   npm dist-tag ls @celsian/adapter-bun
   npm dist-tag ls @celsian/adapter-deno
   # If latest didn't move to 0.5.0, set it explicitly:
   npm dist-tag add @celsian/adapter-bun@0.5.0 latest
   npm dist-tag add @celsian/adapter-deno@0.5.0 latest
   ```

3. **Post-publish smoke (as a brand-new user):**
   ```bash
   cd "$(mktemp -d)"
   npx create-celsian@latest my-api   # should resolve ^0.5.0 deps cleanly
   cd my-api && npm install && npm run build && npm run dev   # boots; curl /health
   npx @celsian/cli routes            # lists routes (scaffold now exports `const app`)
   ```

## Breaking/behavioral notes to call out in the GitHub release
- Response-cache header policy is now a **denylist** of credential headers (security/representation
  headers are preserved and now correctly cached).
- `MemoryKVStore` defaults to a bounded LRU (`maxEntries: 0` restores unbounded).
- Redis queue key schema changed (`:inflight` → `:processing` + `:stamps`) — **drain in-flight
  messages before upgrading** a running deployment.
- `trustProxy` no longer trusts `x-forwarded-host` unless the host is in the new `trustedHosts`
  allowlist (was a host-header-injection vector).

## Not in this release (tracked follow-ups from the product review — GTM, not blocking)
- Reposition the hero around the real wedge (API + jobs + cron + SSE in one process, anywhere).
- Hosted docs site; a live "SaaS backend in one file → CF Workers" demo; refreshed 0.5.0 benchmarks.
- Seed 1–2 third-party-shaped plugins + a "build a plugin" guide.
