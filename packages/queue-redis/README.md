# CelsianJS Redis Queue

Redis-backed queue backend for the CelsianJS task system. Swap the in-memory queue for Redis so background tasks survive restarts and are processed across multiple instances.

This package is part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root repository README for framework documentation, examples, and release notes.

## Installation

```bash
npm install @celsian/queue-redis
```

`ioredis` is included as a dependency — no separate install needed.

## Usage

Assign a `RedisQueue` to `app.queue` before defining tasks. The worker starts automatically when you call `serve()`.

```typescript
import { createApp, serve } from '@celsian/core';
import { RedisQueue } from '@celsian/queue-redis';

const app = createApp({ logger: true });

// Point the task system at Redis
app.queue = new RedisQueue({ url: process.env.REDIS_URL! });

// Define a task
app.task({
  name: 'sendWelcomeEmail',
  retries: 3,
  async handler(input: { to: string }) {
    await sendEmail(input.to, 'Welcome!');
  },
});

// Enqueue it from a route
app.post('/signup', async (req, reply) => {
  const { email } = req.parsedBody as { email: string };
  await app.enqueue('sendWelcomeEmail', { to: email });
  return reply.status(202).json({ queued: true });
});

serve(app, { port: 3000 }); // worker starts here
```

## Options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `url` | `string` | — | Redis connection URL (`redis://...`). Provide this or `client`. |
| `client` | `Redis` | — | An existing `ioredis` client to reuse instead of `url`. |
| `prefix` | `string` | `'celsian:queue'` | Key prefix for all queue keys. |
| `visibilityTimeout` | `number` | `30000` | How long (ms) a popped message stays in-flight before it is auto-requeued. |
| `onError` | `(error: Error) => void` | `console.error` | Connection-error callback for an owned client. Ignored when you pass your own `client`. |

> If you are not using `serve()` (e.g. in serverless or tests), call `app.startWorker()` to begin processing enqueued tasks.

## License

MIT
