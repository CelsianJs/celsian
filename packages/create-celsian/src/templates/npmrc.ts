// Shipped as `.npmrc` in every template.
//
// npm 10, the version bundled with Node 20 and 22, crashes resolving the
// optional peer cycle vitest 4 pulls in through vite (vite -> @vitejs/devtools
// -> vitest): `npm install` dies with "Cannot read properties of null (reading
// 'edgesOut')" before writing anything. npm 11 resolves it. Skipping npm's
// automatic peer install avoids the crash, and no template relies on it: every
// required dependency is listed in package.json, and the only peer a Celsian
// package declares (`ws` on @celsian/core) is optional.
export const NPMRC = `# npm 10 (bundled with Node 20 and 22) crashes resolving vitest's optional
# peer dependencies. Every dependency this project needs is in package.json,
# so npm's automatic peer install is not needed. Safe to delete on npm 11+.
legacy-peer-deps=true
`;
