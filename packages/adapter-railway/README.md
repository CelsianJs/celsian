# CelsianJS Railway Adapter

Generate Railway deployment files for CelsianJS apps. This is a build-time deploy adapter, not an HTTP handler.

Part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root README for full framework docs.

## Installation

```bash
npm install @celsian/adapter-railway
```

## Usage

The adapter is a plain object with a `buildEnd()` method that writes the files.
Call it from a post-build script:

```ts
// scripts/generate-railway-config.ts
import { railwayAdapter } from '@celsian/adapter-railway';

const adapter = railwayAdapter({ healthCheckPath: '/health' });

await adapter.buildEnd({
  serverEntry: 'dist/index.js',
  clientDir: 'dist/client',
  staticDir: 'public',
  outDir: '.',
});
```

```bash
node --experimental-strip-types scripts/generate-railway-config.ts
```

That writes `Procfile`, `railway.json` and `.env.example` into `outDir`. Because
Railway runs a long-lived server, `app.task()` workers and `app.cron()`
schedulers run normally here. Make sure the server binds `0.0.0.0` (the default
in production) so Railway's proxy can reach it.

> This adapter is **not** wired into `celsian.config.ts`. `CelsianConfig` has no
> `build.adapter` key, so the `defineConfig({ build: { adapter } })` form this
> README used to show did not type-check and was never read by `celsian build`.

## License

MIT
