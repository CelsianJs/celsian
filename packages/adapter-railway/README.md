# CelsianJS Railway Adapter

Generate Railway deployment files for CelsianJS apps. This is a build-time deploy adapter, not an HTTP handler.

Part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root README for full framework docs.

## Installation

```bash
npm install @celsian/adapter-railway
```

## Usage

Reference the adapter from your `celsian.config.ts`:

```ts
import { defineConfig } from '@celsian/core';
import { railwayAdapter } from '@celsian/adapter-railway';

export default defineConfig({
  build: {
    adapter: railwayAdapter({ healthCheckPath: '/health' }),
  },
});
```

`celsian build` then emits the Railway config. Because Railway runs a long-lived
server, `app.task()` workers and `app.cron()` schedulers run normally here. Make
sure the server binds `0.0.0.0` (the default in production) so Railway's proxy
can reach it.

## License

MIT
