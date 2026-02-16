# CelsianJS

AI-native TypeScript backend framework. Built for humans and agents to use together.

## Packages

| Package | Description |
|---------|-------------|
| [`@celsian/core`](packages/core) | Server runtime — routing, hooks, lifecycle |
| [`@celsian/schema`](packages/schema) | Standard Schema adapters (TypeBox, Zod, Valibot) |
| [`@celsian/rpc`](packages/rpc) | Type-safe RPC with OpenAPI generation |
| [`@celsian/cli`](packages/cli) | Developer CLI — dev server, generators |
| [`celsian`](packages/celsian) | Meta-package — single import for everything |
| [`create-celsian`](packages/create-celsian) | Project scaffolder |

## Quick Start

```bash
npx create-celsian my-api
cd my-api
npm run dev
```

Or manually:

```typescript
import { createApp, serve } from 'celsian';

const app = createApp();

app.get('/health', (req, reply) => reply.json({ status: 'ok' }));

serve(app, { port: 3000 });
```

## Part of the ThenJS Stack

- **What Framework** — frontend (signals, fine-grained reactivity)
- **CelsianJS** — backend (this project)
- **ThenJS** — meta-framework glue (SSR, file routing, RPC, build)

## License

MIT
