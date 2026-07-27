---
"@celsian/adapter-fly": patch
"@celsian/adapter-railway": patch
"@celsian/adapter-cloudflare": patch
"@celsian/adapter-lambda": patch
"@celsian/ws-redis": patch
"celsian": patch
---

Correct the deploy-adapter usage docs and clean up the published comment surface.

- **`flyAdapter()` and `railwayAdapter()` documented an API that does not
  exist.** Both JSDoc examples showed
  `defineConfig({ build: { adapter: flyAdapter(...) } })`, but `CelsianConfig`
  has no `build` key and nothing reads one, so following the doc produced a
  config object that was silently ignored and no `fly.toml` / `Procfile` was
  ever written. Both now document the path that works: call `buildEnd()` from a
  post-build script, with its real argument shape.
- Em-dashes are removed from every published source comment and generated file
  header across these packages, so the text in the shipped `.d.ts` files and in
  generated `fly.toml` / `Dockerfile` output is plain ASCII.

No runtime behaviour changes in any of these packages. They are versioned only
to keep the release line in lockstep and to give each one an accurate changelog
entry for what actually changed.
