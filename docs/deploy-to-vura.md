# Deploy to Vura

Vura runs a CelsianJS app with no configuration: connect the repo, and Vura starts it as one web service with your package manager's `start` script.

## 1. Let `serve()` pick the port and host

```typescript
import { createApp, serve } from '@celsian/core';

const app = createApp({ clientIp: { header: 'x-vura-client-ip' } });
app.get('/', (req, reply) => reply.json({ ip: req.ip }));

serve(app); // reads PORT and HOST from the environment
```

Vura sets `PORT=3001` and `HOST=127.0.0.1`. Its supervisor is the only thing listening publicly, and it forwards only signed requests from the Vura edge. If you hard-code a port, the deploy fails with "The app did not listen on $PORT (3001). Pass no port to serve(), or read process.env.PORT." Because the bind is loopback and `NODE_ENV=production`, `serve()` logs a warning that a production server is bound to loopback and unreachable from outside the container. On Vura this is expected: the supervisor, not the outside world, is what connects to that loopback address.

A zero-config deploy like this one runs on Vura's default service size. Free and starter plans cap service size at 256 MB (`nano`); a size over your plan's cap fails the deploy with 422 `SERVICE_SIZE_NOT_ALLOWED`. If that happens, declare the service explicitly in `vura.json` with `"size": "nano"`, or move to a plan with a higher cap.

## 2. Add a `start` script

```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js"
  },
  "dependencies": { "@celsian/core": "^0.6.5" }
}
```

Without a `start` script the build fails with "This Celsian app has no start script. Add one to package.json or declare services in vura.json." Vura runs `build` when it exists. The package manager (npm, pnpm or yarn) comes from your lockfile.

## 3. Client IP

`clientIp: { header: 'x-vura-client-ip' }` makes `request.ip` the caller's real address. The Vura edge always overwrites that header from Cloudflare's verified connecting IP before your request reaches your service, so it is the one you can trust. Vura also keeps `fly-client-ip`, `x-forwarded-for` and `x-real-ip` in sync with the same value for compatibility with generic middleware, but `x-vura-client-ip` is the canonical header to configure.

## More than one process

For an API plus a queue worker, declare services in `vura.json`. See the [Vura services guide](https://vura.io/platform/services/).
