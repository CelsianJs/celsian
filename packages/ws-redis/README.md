# CelsianJS WebSocket Redis Adapter

Distributed WebSocket broadcast via Redis pub/sub for multi-instance CelsianJS deployments. A message broadcast on one node is relayed to connections on every other node.

This package is part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root repository README for framework documentation, examples, and release notes.

## Installation

```bash
npm install @celsian/ws-redis
```

`ioredis` is included as a dependency.

## Usage

Wrap the app's `wsRegistry` with a `RedisWSAdapter`. Broadcast through the adapter (not `app.wsBroadcast`) so the message fans out across all nodes.

```typescript
import { createApp, serve } from '@celsian/core';
import { RedisWSAdapter } from '@celsian/ws-redis';

const app = createApp();

// Define a WebSocket route
app.ws('/chat', {
  open(ws) { ws.send('welcome'); },
  message(ws, data) { /* handle inbound message */ },
});

// Bridge this node's connections to Redis pub/sub
const wsRedis = new RedisWSAdapter(app.wsRegistry, { url: process.env.REDIS_URL! });
await wsRedis.subscribePath('/chat');

// Broadcast to /chat on EVERY node (local + remote)
await wsRedis.broadcast('/chat', JSON.stringify({ msg: 'hello everyone' }));

serve(app, { port: 3000 });
```

A convenience factory is also exported:

```typescript
import { createRedisWSAdapter } from '@celsian/ws-redis';

const wsRedis = createRedisWSAdapter('redis://localhost:6379')(app.wsRegistry);
```

## Options

`new RedisWSAdapter(registry, options)` takes:

| Option | Type | Description |
| ------ | ---- | ----------- |
| `url` | `string` | Redis connection URL (`redis://...`). Provide this, or both `publisher` and `subscriber`. |
| `publisher` | `Redis` | An existing `ioredis` client for publishing. |
| `subscriber` | `Redis` | An existing `ioredis` client for subscribing. |
| `onError` | `(error: Error) => void` | Connection-error callback for owned clients. Ignored when you pass your own `publisher`/`subscriber`. |

Key methods: `subscribePath(path)`, `broadcast(path, data, exclude?)`, `broadcastAll(data, exclude?)` (cross-node `*` fan-out), and `close()` to tear down the Redis connections.

> WebSocket serving requires a runtime that supports it. On Node, install `ws` (`npm i ws`); Bun serves WebSockets natively. This adapter only relays broadcasts between nodes — it does not change which runtimes can accept connections.

## License

MIT
