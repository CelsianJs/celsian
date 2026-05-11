# CelsianJS — Next Session Pickup

## Current wrapped state — 2026-05-11

Code-side hardening sprint work is wrapped for CelsianJS.

Current head:

- `main@9d00f30`
- Working tree clean at final audit.

Released public registry state:

- Changed public packages are published at `0.3.16`: `@celsian/adapter-cloudflare`, `@celsian/adapter-fly`, `@celsian/adapter-lambda`, `@celsian/adapter-node`, `@celsian/adapter-railway`, `@celsian/adapter-vercel`, `celsian`, `@celsian/cli`, `@celsian/compress`, `@celsian/core`, `@celsian/jwt`, `@celsian/queue-redis`, and `@celsian/rate-limit`.
- Intentionally unchanged public packages remain at `0.3.15`: `@celsian/cache`, `create-celsian`, `@celsian/rpc`, and `@celsian/schema`.

Latest verified gates:

- GitHub Test `25654463958` passed on `main@9d00f30`.
- GitHub Release `25654463954` passed on `main@9d00f30`.
- Registry consumer smoke verified `@celsian/core@0.3.16` applies global `security()` headers to matched routes, framework 404s, and framework 405s.

Important fix landed during wrap:

- Framework-generated 404/405 miss responses now run root `onRequest` hooks and merge reply headers, so global security middleware covers miss responses as documented.

Open queue:

- Only Dependabot maintenance PRs remain open. They were green/mergeable at final audit but are dependency-maintenance work, not sprint hardening blockers.

Resume command:

```bash
cd celsian
npx -y pnpm@9.15.0 test
npx -y pnpm@9.15.0 verify:publish
npx -y pnpm@9.15.0 verify:registry
```
