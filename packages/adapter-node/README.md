# @celsian/adapter-node

Node.js deployment adapter for CelsianJS. Provides a `serve()` function for running a `CelsianApp` on `node:http`, plus low-level Node/Web conversion helpers.

## Install

```
npm install @celsian/adapter-node
```

Peer dependency: `@celsian/core`.

## Usage

### Runtime `serve()`

Use `serve()` to start a Node HTTP server from a `CelsianApp` instance directly (useful for custom setups):

```typescript
import { createApp } from '@celsian/core';
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
| `default` | Alias of `serve` |
| `serve(app, options?)` | Start a `node:http` server from a `CelsianApp` |
| `nodeToWebRequest(req, url)` | Convert `IncomingMessage` to Web Standard `Request` |
| `writeWebResponse(res, response)` | Write a Web Standard `Response` to `ServerResponse` |
| `NodeAdapterOptions` | Options for `serve()`: `{ port?, host?, staticDir? }` |

## License

[MIT](../../LICENSE)
