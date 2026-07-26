# CelsianJS Bun Adapter

Deploy CelsianJS apps on Bun with native WebSocket upgrade support.

This package is part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root repository README for framework documentation, examples, and release notes.

## Usage

```ts
import { createApp } from "@celsian/core";
import { createBunServeOptions } from "@celsian/adapter-bun";

const app = createApp();
app.get("/hello", () => ({ message: "world" }));
app.ws("/live", {
  open(ws, req) { /* ... */ },
  message(ws, data) { ws.send(data); },
});
await app.ready();

Bun.serve(createBunServeOptions(app, { port: 3000 }));
```

`createBunServeOptions()` returns `{ port, hostname, fetch, websocket }`. The
`websocket` key is required by Bun: `server.upgrade()` cannot succeed without it.
If you assemble the options yourself, pair `createBunHandler(app)` with
`createBunWebSocketHandler(app)`, one without the other will not serve WebSockets.

## WebSocket upgrades are gated

A WebSocket handshake is **not** subject to the same-origin policy or CORS: a page
on `evil.com` can open `new WebSocket("wss://your.app/live")` and the browser will
attach your app's cookies. That is cross-site WebSocket hijacking (CSWSH).

This adapter therefore gates every upgrade **before** calling `server.upgrade()`:

1. **Origin check**, same-origin by default (the handshake's `Origin` must match
   its `Host`). A handshake with **no** `Origin` header is rejected by default.
2. **Root `onRequest` hooks**, JWT guards, rate limiters, and any other root-level
   `onRequest` hooks run on the handshake. A hook that returns a `Response` rejects it.
3. **Per-IP connection cap** and a **max payload size**.

```ts
Bun.serve(
  createBunServeOptions(app, {
    port: 3000,
    allowedOrigins: ["https://app.example.com", "https://admin.example.com"],
    // allowedOrigins: "*"                 // any origin, opt in deliberately
    // allowedOrigins: (origin) => ...     // predicate
    allowMissingOrigin: false,  // default; true permits non-browser clients (CLIs, service-to-service)
    maxPayload: 1024 * 1024,    // default 1 MiB
    maxConnectionsPerIP: 64,    // default; 0 disables
    skipUpgradeHooks: false,    // default; true skips root onRequest hooks
  }),
);
```

Route-level hooks still do not run, a `.ws()` path is not an HTTP route, so
per-connection authorization is best done in the `open` handler, which receives
the upgrade request:

```ts
app.ws("/live", {
  open(ws, req) {
    const token = new URL(req.url).searchParams.get("token");
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

## API

| Export | Description |
|---|---|
| `createBunHandler(app, options?)` | Bun `fetch` handler; returns `undefined` after a successful upgrade |
| `createBunWebSocketHandler(app, options?)` | Bun `websocket` handler (`open`/`message`/`close`/`drain`) |
| `createBunServeOptions(app, options?)` | Full `Bun.serve` options, including `websocket` when the app has `.ws()` routes |
| `default` | Alias of `createBunHandler` |

## License

[MIT](../../LICENSE)
