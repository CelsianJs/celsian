# CelsianJS

Backend framework built on Web Standard APIs. Multi-runtime server with plugin encapsulation, schema validation, type-safe RPC, background tasks, cron, and WebSocket support.

## Install

```bash
npm install celsian
```

Or scaffold a new project:

```bash
npx create-celsian my-app
cd my-app
npm install
npm run dev
```

## Quick Example

```ts
import { createApp, serve } from 'celsian'

const app = createApp()

app.get('/hello/:name', (req, reply) => {
  return reply.json({ message: `Hello, ${req.params.name}!` })
})

serve(app, { port: 3000 })
```

## Features

- **Plugin encapsulation** -- Fastify-style scoped hooks and decorations. No accidental middleware leaks.
- **Schema validation** -- Auto-detects Zod, TypeBox, or Valibot. No config, no adapters.
- **Type-safe RPC** -- Define procedures with schemas, get end-to-end type safety via `@celsian/rpc`.
- **Multi-runtime** -- Runs on Node.js, Bun, Deno, Cloudflare Workers, AWS Lambda, Vercel.
- **Background tasks** -- Queue-based task processing with retries and timeouts.
- **Cron jobs** -- Schedule recurring tasks with cron expressions.
- **WebSocket** -- Built-in WebSocket support with broadcast and connection management.
- **Security** -- CORS, CSRF protection, Helmet-style headers, rate limiting, JWT auth.
- **OpenAPI** -- Auto-generated API documentation with Swagger UI.

## What this package re-exports

`celsian` is a convenience meta-package. It re-exports **`@celsian/core` and `@celsian/schema` only**:

| Package | Re-exported here? | Contents |
|---------|-------------------|----------|
| `@celsian/core` | Yes, in full | Every export, including `createApp`, `serve`, `cors`, `csrf`, `security`, `openapi`, `database`, `upload`, `createSSEHub`, tasks and cron, WebSocket helpers, errors, logger, cookies, ETag, config |
| `@celsian/schema` | Yes, in full | `fromSchema`, `fromZod`, `fromTypeBox`, `fromValibot`, `coerceQueryParams`, `coerceString` |

Both are re-exported with `export *`, so anything `@celsian/core` exports is reachable
from `celsian` under the same name. Before 0.6.0 this was a hand-maintained list that had
drifted to 33 of core's 65 exports, which is why `upload` and `createSSEHub` used to come
back `undefined` here despite being documented in the core README.

Everything else is a separate install and is **not** available from `celsian`:

```bash
npm install @celsian/rpc          # type-safe RPC procedures
npm install @celsian/jwt          # JWT auth plugin
npm install @celsian/rate-limit   # rate limiting
npm install @celsian/cache        # response cache, session store
npm install @celsian/compress     # gzip/deflate
npm install -D @celsian/cli       # dev server, routes, build, deploy
```

```ts
// Correct: RPC comes from its own package.
import { createApp, serve } from 'celsian';
import { procedure, router, RPCHandler } from '@celsian/rpc';
```

## Documentation

See the [GitHub repository](https://github.com/CelsianJs/celsian) for full documentation:

- [Quick Start](https://github.com/CelsianJs/celsian#quick-start)
- [Hooks Lifecycle](https://github.com/CelsianJs/celsian/blob/main/docs/hooks.md)
- [Plugins and Encapsulation](https://github.com/CelsianJs/celsian/blob/main/docs/plugins.md)
- [Deployment Guide](https://github.com/CelsianJs/celsian/blob/main/docs/deployment.md)

## License

MIT
