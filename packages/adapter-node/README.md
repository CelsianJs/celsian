# @celsian/adapter-node

Node.js deployment adapter for CelsianJS. Generates a standalone `node:http` server entry from the build output, and provides a `serve()` function for running a `CelsianApp` at runtime.

## Install

```
npm install @celsian/adapter-node
```

Peer dependencies: `@celsian/server`, `@celsian/build`.

## Usage

### Build Adapter

Set the adapter in your config and the build pipeline will invoke it automatically:

```typescript
// then.config.ts
import { defineConfig } from 'celsian';

export default defineConfig({
  build: {
    adapter: 'node', // or 'auto' (detects Node when no platform env is set)
  },
});
```

After `celsian build`, the adapter generates a standalone server entry at `dist/server/` that:

1. Serves static client assets with immutable cache headers
2. Serves pre-rendered HTML from the static directory
3. Converts incoming Node requests to Web Standard `Request` objects
4. Passes them to the built CelsianApp handler

Run the production server:

```
node dist/server/entry-server.js
```

### Runtime `serve()`

Use `serve()` to start a Node HTTP server from a `CelsianApp` instance directly (useful for custom setups):

```typescript
import { createApp } from '@celsian/server';
import { serve } from '@celsian/adapter-node';

const app = createApp();

app.get('/health', (req, reply) => {
  return reply.json({ status: 'ok' });
});

serve(app, {
  port: 3000,       // default: process.env.PORT || 3000
  host: '0.0.0.0',  // default: '0.0.0.0'
  staticDir: './public',
});
```

### Conversion Helpers

For advanced use, the package also exports low-level helpers:

```typescript
import { nodeToWebRequest, writeWebResponse } from '@celsian/adapter-node';

// Convert a Node IncomingMessage + URL to a Web Standard Request
const webReq = nodeToWebRequest(req, url);

// Write a Web Standard Response back to a Node ServerResponse
await writeWebResponse(res, webResponse);
```

## API

| Export | Description |
|---|---|
| `default` (adapter) | Build adapter with `buildEnd()` hook -- generates standalone server entry |
| `serve(app, options?)` | Start a `node:http` server from a `CelsianApp` |
| `nodeToWebRequest(req, url)` | Convert `IncomingMessage` to Web Standard `Request` |
| `writeWebResponse(res, response)` | Write a Web Standard `Response` to `ServerResponse` |
| `NodeAdapterOptions` | Options for `serve()`: `{ port?, host?, staticDir? }` |

## License

[MIT](../../LICENSE)
