import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  outdir: 'dist',
  external: ['node:*'],
  minify: true,
  banner: {
    js: '// CelsianJS Docker Example — Built with esbuild',
  },
});

console.log('Built to dist/index.js');
