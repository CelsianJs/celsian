# @celsian/core

TypeScript backend framework built on Web Standard APIs. Multi-runtime (Node.js, Bun, Deno, Cloudflare Workers, Lambda, Vercel), with built-in task queues, cron, WebSocket, and plugin encapsulation.

## Install

```bash
npm install @celsian/core
```

## Usage

```typescript
import { createApp, serve } from '@celsian/core';

const app = createApp({ logger: true });
app.get('/hello', (req, reply) => reply.json({ message: 'Hello!' }));
app.task({ name: 'email', handler: async (input) => sendEmail(input), retries: 3 });
app.cron('cleanup', '0 3 * * *', () => db.deleteExpired());
serve(app, { port: 3000 });
```

## Documentation

See the [main repository](https://github.com/CelsianJs/celsian) for full docs, examples, and API reference.

## License

MIT
