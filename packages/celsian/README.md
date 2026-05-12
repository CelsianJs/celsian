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

## Packages

This is a convenience meta-package that re-exports from the CelsianJS monorepo:

| Package | Description |
|---------|-------------|
| `@celsian/core` | Server runtime, routing, hooks, plugins, tasks, cron, WebSocket |
| `@celsian/schema` | Standard Schema adapters (Zod, TypeBox, Valibot) |
| `@celsian/rpc` | Type-safe RPC procedures, middleware, typed client |
| `@celsian/cli` | Dev server, route listing, code generation |

## Documentation

See the [GitHub repository](https://github.com/CelsianJs/celsian) for full documentation:

- [Quick Start](https://github.com/CelsianJs/celsian#quick-start)
- [Hooks Lifecycle](https://github.com/CelsianJs/celsian/blob/main/docs/hooks.md)
- [Plugins and Encapsulation](https://github.com/CelsianJs/celsian/blob/main/docs/plugins.md)
- [Deployment Guide](https://github.com/CelsianJs/celsian/blob/main/docs/deployment.md)

## License

MIT
