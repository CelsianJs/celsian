# @celsian/server

Hook-based server runtime built on Web Standard APIs (Request/Response). Provides routing, lifecycle hooks, plugin encapsulation, and configuration for CelsianJS applications.

## Install

```
npm install @celsian/server
```

## Usage

### Creating an App

```typescript
import { createApp } from '@celsian/server';

const app = createApp({ prefix: '/api' });

app.get('/hello', (request, reply) => {
  return reply.json({ message: 'Hello, world!' });
});

app.post('/users', async (request, reply) => {
  const body = request.parsedBody as { name: string };
  return reply.status(201).json({ id: crypto.randomUUID(), name: body.name });
});

// Handle a Web Standard Request (used by adapters)
const response = await app.handle(request);

// Or use as a fetch handler (Bun, Deno)
// Bun.serve({ fetch: app.fetch });
```

### Lifecycle Hooks

Hooks run at specific points in the request lifecycle. Return a `Response` from any hook to short-circuit:

```typescript
app.addHook('onRequest', async (request, reply) => {
  const token = request.headers.get('authorization');
  if (!token) {
    return reply.status(401).json({ error: 'Unauthorized' });
  }
});

app.addHook('onError', async (error, request, reply) => {
  console.error('Request failed:', error.message);
  return reply.status(500).json({ error: 'Something went wrong' });
});
```

Hook order: `onRequest` -> `preParsing` -> body parse -> `preValidation` -> `preHandler` -> handler -> `preSerialization` -> `onSend` -> `onResponse`

### Plugins

Plugins run in an encapsulated context. Hooks and decorators registered inside a plugin do not leak to sibling plugins:

```typescript
import type { PluginContext } from '@celsian/server';

async function authPlugin(app: PluginContext, opts: Record<string, unknown>) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request, reply) => {
    (request as any).user = await validateToken(request);
  });

  app.get('/me', (request, reply) => {
    return reply.json((request as any).user);
  });
}

await app.register(authPlugin, { prefix: '/auth' });
```

### Configuration

```typescript
import { defineConfig } from '@celsian/server';

export default defineConfig({
  server: {
    port: 3000,
    host: 'localhost',
    defaultPageMode: 'hybrid',
  },
  build: {
    adapter: 'auto',
    outDir: 'dist',
  },
  rpc: {
    schema: 'zod',
  },
});
```

## API

| Export | Description |
|---|---|
| `createApp(options?)` | Create a new `CelsianApp` instance |
| `CelsianApp` | Server class with `handle(Request)`, route methods, hooks, plugins |
| `Router` | Radix-tree router with param (`:id`) and wildcard (`*path`) support |
| `createReply()` | Build a `CelsianReply` with chainable `.status()`, `.header()`, `.json()`, `.html()`, `.stream()`, `.redirect()` |
| `defineConfig(config)` | Type-safe config helper |
| `loadConfig(root?)` | Load `then.config.{ts,js,mjs}` with defaults |

### Route Methods

`app.get`, `app.post`, `app.put`, `app.patch`, `app.delete`, `app.route`

### Hook Names

`onRequest`, `preParsing`, `preValidation`, `preHandler`, `preSerialization`, `onSend`, `onResponse`, `onError`

## License

[MIT](../../LICENSE)
