# CelsianJS Bun Adapter

Deploy CelsianJS apps on Bun with native WebSocket upgrade support.

This package is part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root repository README for framework documentation, examples, and release notes.

## WebSocket upgrades bypass route hooks

The adapter calls Bun's `server.upgrade()` **before** the request enters the
CelsianJS hook lifecycle. A WebSocket upgrade request never reaches
`onRequest`/`preHandler` hooks — so JWT guards, rate limiters, and any other
route-level middleware **do not run** for WS connections.

Authenticate inside the WebSocket `open` handler instead. The `open` callback
receives the upgrade request, so you can validate a token from the query string
or `Sec-WebSocket-Protocol` header and close unauthorized connections:

```ts
import { createApp } from "@celsian/core";

const app = createApp();

app.ws("/live", {
  open(ws, req) {
    // Hooks did NOT run for this connection — validate here.
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const user = verifyToken(token); // e.g. app.jwt.verify(token)
    if (!user) {
      ws.close(1008, "Unauthorized"); // 1008 = policy violation
      return;
    }
    ws.metadata.user = user;
  },
  message(ws, data) {
    // ws.metadata.user is set for authenticated connections
  },
});
```

The same applies to rate limiting: if you need to throttle WS connection
attempts, track them yourself in the `open` handler — `@celsian/rate-limit`
hooks will not see upgrade requests.
