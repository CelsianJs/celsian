# CelsianJS Fly.io Adapter

Generate Fly.io deployment files (`fly.toml`, `Dockerfile`) for CelsianJS apps. This is a build-time deploy adapter, not an HTTP handler.

Part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root README for full framework docs.

## Installation

```bash
npm install @celsian/adapter-fly
```

## Usage

The adapter is a plain object with a `buildEnd()` method that writes the files.
Call it from a post-build script:

```ts
// scripts/generate-fly-config.ts
import { flyAdapter } from '@celsian/adapter-fly';

const adapter = flyAdapter({
  appName: 'my-app',
  primaryRegion: 'iad',
  regions: ['lhr', 'nrt'],
  healthCheckPath: '/health',
});

await adapter.buildEnd({
  serverEntry: 'dist/index.js',
  clientDir: 'dist/client',
  staticDir: 'public',
  outDir: '.',
});
```

```bash
node --experimental-strip-types scripts/generate-fly-config.ts
```

That writes `fly.toml`, `Dockerfile` and `.dockerignore` into `outDir`; deploy
with `fly deploy`. Because Fly runs a long-lived server, `app.task()` workers and
`app.cron()` schedulers run normally here.

> This adapter is **not** wired into `celsian.config.ts`. `CelsianConfig` has no
> `build.adapter` key, so the `defineConfig({ build: { adapter } })` form this
> README used to show did not type-check and was never read by `celsian build`.

## License

MIT
