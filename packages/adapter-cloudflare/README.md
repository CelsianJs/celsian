# CelsianJS Cloudflare Workers Adapter

Run CelsianJS apps on Cloudflare Workers (workerd).

Part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root README for full framework docs.

## Installation

```bash
npm install @celsian/core @celsian/adapter-cloudflare
```

## Usage

```ts
// worker.ts
import { createApp } from '@celsian/core';
import { createCloudflareHandler } from '@celsian/adapter-cloudflare';

const app = createApp();
app.get('/', (req, reply) => reply.json({ ok: true }));

// Returns { fetch, scheduled } — both Worker entry points.
export default createCloudflareHandler(app);
```

The exported `scheduled` handler bridges Cloudflare **Cron Triggers** to your
`app.cron()` jobs, so scheduled work runs even though Workers are short-lived.
Configure triggers in `wrangler.toml`:

```toml
[triggers]
crons = ["0 3 * * *"]
```

`app.task()` workers do not run on Workers — back durable jobs with
`@celsian/queue-redis` and a long-running worker. See the root deployment docs.

## License

MIT
