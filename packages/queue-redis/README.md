# CelsianJS Redis Queue

Redis-backed queue backend for the CelsianJS task system. Swap the in-memory queue for Redis so background tasks survive restarts and are processed across multiple instances.

This package is part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root repository README for framework documentation, examples, and release notes.

## Installation

```bash
npm install @celsian/queue-redis
```

`ioredis` is included as a dependency, no separate install needed.

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
| `url` | `string` | none | Redis connection URL (`redis://...`). Provide this or `client`. |
| `client` | `Redis` | none | An existing `ioredis` client to reuse instead of `url`. |
| `prefix` | `string` | `'celsian:queue'` | Key prefix for all queue keys. |
| `visibilityTimeout` | `number` | `30000` | How long (ms) a popped message stays leased to one worker before it is reclaimed and redelivered. |
| `maxDeadLetters` | `number` | `10000` | Maximum dead-letter entries retained; the oldest are trimmed away. |
| `onError` | `(error: Error) => void` | `console.error` | Connection-error callback for an owned client. Ignored when you pass your own `client`. |

> If you are not using `serve()` (e.g. in serverless or tests), call `app.startWorker()` to begin processing enqueued tasks.

## Delivery guarantees

- **At-least-once.** Every delivery gets its own lease token. An ack, nack or heartbeat only affects the delivery that holds the lease, so a worker whose lease already expired can never complete or requeue the job another worker has since taken over.
- **Exactly-once promotion of delayed messages.** Retries and delayed jobs are promoted by a single Lua script, gated on `ZREM` returning 1, so concurrent workers cannot duplicate a delayed job or delete one that became due mid-promotion.
- **No silent loss on reclaim.** A lease that expires without an ack or heartbeat draws down the same retry budget as an explicit failure. Once that budget is spent the job is dead-lettered rather than redelivered forever.

## Long-running tasks

A task must finish inside the visibility timeout, otherwise its lease expires and it is redelivered while still running. The worker heartbeats automatically, and a handler can extend its own lease:

```typescript
app.task({
  name: 'importCatalog',
  timeout: 20 * 60_000,
  longRunning: true, // required when timeout >= visibilityTimeout
  async handler(input, ctx) {
    for (const batch of batches) {
      if (ctx.signal.aborted) return; // aborted on timeout or shutdown
      await importBatch(batch);
      await ctx.heartbeat(); // false means the lease was lost
    }
  },
});
```

Registering a task whose `timeout` is not below `visibilityTimeout` throws unless `longRunning: true` is set, because that configuration guarantees the job runs concurrently with itself. `longRunning` only holds the lease if the handler yields to the event loop; a handler that blocks it will still be redelivered.

## Dead-letter queue

Jobs that exhaust their retries are moved to a dead-letter queue instead of being discarded, along with the final error and the full attempt history.

```typescript
const queue = new RedisQueue({ url: process.env.REDIS_URL! });
app.queue = queue;

app.setTaskWorkerOptions({
  onFailure: ({ message, error, willRetry }) => metrics.taskFailed(message.taskName, willRetry),
  onDeadLetter: (entry) => alert(`${entry.message.taskName} died after ${entry.failures.length} attempts: ${entry.error}`),
});

// Inspect and re-drive
const dead = await queue.listDeadLetters(50);
await queue.redriveDeadLetter(dead[0].message.id); // one job, retry budget reset
await queue.redriveDeadLetters(100);               // in bulk
await queue.purgeDeadLetters();                    // discard permanently
```

## Testing

The Lua scripts in this package are only exercised against a real Redis. `packages/queue-redis/test/redis-queue.test.ts` connects to `$REDIS_URL` (defaulting to `redis://127.0.0.1:6379`); it skips with a loud notice locally when no server is reachable, and **fails** when `CI` is set, so the suite can never silently stop covering the scripts.

```bash
docker run --rm -p 6379:6379 redis:7-alpine
pnpm test
```

## License

MIT
