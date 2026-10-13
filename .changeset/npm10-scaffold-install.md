---
"create-celsian": patch
---

Scaffolded projects now install on npm 10, the version bundled with Node 20 and 22. `npm install` in a fresh `npm create celsian@latest` project crashed with "Cannot read properties of null (reading 'edgesOut')" while resolving vitest's optional peer dependencies. Every template now ships an `.npmrc` with `legacy-peer-deps=true`, and the `full` template's Dockerfile copies it before `npm ci`.
