// Build script: bundles the Worker into a single file for Cloudflare
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser', // Workers runtime = Web Standards, not Node.js
  outfile: 'dist/index.js',
  external: ['node:*'],
  minify: true,
  sourcemap: false,
  treeShaking: true,
  conditions: ['worker', 'browser'],
});

console.log('Build complete: dist/index.js');
