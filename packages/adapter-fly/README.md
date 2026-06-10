# CelsianJS Fly.io Adapter

Generate Fly.io deployment files (`fly.toml`, `Dockerfile`) for CelsianJS apps. This is a build-time deploy adapter, not an HTTP handler.

Part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root README for full framework docs.

## Installation

```bash
npm install @celsian/adapter-fly
```

## Usage

Reference the adapter from your `celsian.config.ts`:

```ts
import { defineConfig } from '@celsian/core';
import { flyAdapter } from '@celsian/adapter-fly';

export default defineConfig({
  build: {
    adapter: flyAdapter({
      appName: 'my-app',
      primaryRegion: 'iad',
      regions: ['lhr', 'nrt'],
    }),
  },
});
```

`celsian build` then emits the Fly config; deploy with `fly deploy`. Because Fly
runs a long-lived server, `app.task()` workers and `app.cron()` schedulers run
normally here.

## License

MIT
