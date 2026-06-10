# CelsianJS Deno Adapter

Run CelsianJS apps on Deno.

Part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root README for full framework docs.

## Installation

```bash
npm install @celsian/core @celsian/adapter-deno
```

## Usage

`serve()` from `@celsian/core` auto-detects Deno, so most apps need no adapter.
Use this package when you want an explicit fetch handler for `Deno.serve`:

```ts
import { createApp } from '@celsian/core';
import { createDenoHandler } from '@celsian/adapter-deno';

const app = createApp();
app.get('/', (req, reply) => reply.json({ runtime: 'deno' }));

Deno.serve(createDenoHandler(app));
// or: import { serveDeno } from '@celsian/adapter-deno'; serveDeno(app, { port: 8000 });
```

Run with the permissions your app needs, e.g.
`deno run --allow-net --allow-env server.ts`. WebSocket routes are not yet
supported on Deno. See the root deployment docs.

## License

MIT
