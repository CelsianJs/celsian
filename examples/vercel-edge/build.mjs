// Build script: bundles the Edge function into a single file for Vercel
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const FUNC_DIR = '.vercel/output/functions/api.func';
mkdirSync(FUNC_DIR, { recursive: true });

// Bundle API into single file
await build({
  entryPoints: ['api/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser', // Edge runtime = no Node.js APIs
  outfile: `${FUNC_DIR}/index.js`,
  external: ['node:*'], // Exclude Node.js builtins (serve.ts won't run in Edge)
  minify: true,
  sourcemap: false,
  treeShaking: true,
});

// Write Edge function config
writeFileSync(`${FUNC_DIR}/.vc-config.json`, JSON.stringify({
  runtime: 'edge',
  entrypoint: 'index.js',
}));

// Write Vercel output config
mkdirSync('.vercel/output', { recursive: true });
writeFileSync('.vercel/output/config.json', JSON.stringify({
  version: 3,
  routes: [
    { src: '/api/(.*)', dest: '/api' },
    { src: '/(.*)', dest: '/api' },
  ],
}));

console.log('Build complete: .vercel/output/');
