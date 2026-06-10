# CelsianJS Vercel Adapter

Run CelsianJS apps on Vercel — both the **Node.js** serverless runtime and the **Edge** runtime.

Part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root README for full framework docs.

## Installation

```bash
npm install @celsian/core @celsian/adapter-vercel
```

## Usage

Node serverless runtime:

```ts
// api/index.ts
import { createApp } from '@celsian/core';
import { createVercelHandler } from '@celsian/adapter-vercel';

const app = createApp();
app.get('/api/hello', (req, reply) => reply.json({ ok: true }));

export default createVercelHandler(app);
```

Edge runtime (no Node built-ins; bundles cleanly for workerd-style edges):

```ts
import { createVercelEdgeHandler } from '@celsian/adapter-vercel';
export const config = { runtime: 'edge' };
export default createVercelEdgeHandler(app);
```

For scheduled work, `createVercelCronHandler(app, process.env.CRON_SECRET)`
validates Vercel Cron requests (timing-safe) and runs the matching `app.cron()`
jobs. `app.task()` workers need a durable queue (`@celsian/queue-redis`). See the
root deployment docs.

## License

MIT
