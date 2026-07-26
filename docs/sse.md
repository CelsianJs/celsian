# Server-Sent Events (SSE)

SSE ships in `@celsian/core` with no extra install. It is a one-way server-to-client
stream over plain HTTP, which makes it a simpler fit than WebSocket for live dashboards,
progress bars, notification feeds, and streaming model output. Unlike WebSocket in
CelsianJS, SSE needs no runtime-specific package: it is built on `Response` and a
`ReadableStream`, so it works on every supported runtime.

Every snippet on this page was executed against a running server before publishing.

## Two APIs

| API | Use it for |
| --- | --- |
| `createSSEStream(request, options?)` | One client, one stream. The handler owns the channel. |
| `createSSEHub(options?)` | Many clients, one broadcast. The hub owns the channels. |

Both return `SSEChannel` objects. A channel's `.response` is what you return from the
route handler.

## Single stream

```typescript
import { createApp, createSSEStream } from '@celsian/core';

const app = createApp();

app.get('/clock', (req) => {
  const channel = createSSEStream(req, { pingInterval: 30_000 });

  let n = 0;
  const timer = setInterval(() => {
    // The client may have disconnected; always check before sending.
    if (!channel.open) return clearInterval(timer);
    channel.send({ event: 'tick', id: String(++n), data: { n } });
  }, 1000);

  return channel.response;
});
```

The client sees standard SSE frames:

```
event: tick
id: 1
data: {"n":1}

event: tick
id: 2
data: {"n":2}
```

`data` is JSON-stringified when it is not a string. Multi-line strings are split across
multiple `data:` lines, per the SSE spec, so newlines survive the round trip.

## Broadcast hub

```typescript
import { createApp, createSSEHub } from '@celsian/core';

const app = createApp();
const hub = createSSEHub({ maxIdleMs: 300_000 });

// Subscribe. There is NO hub.connect(); the method is subscribe().
app.get('/events', (req) => hub.subscribe(req).response);

// Anything on the server can now push to every subscriber.
app.post('/publish', async (req, reply) => {
  hub.broadcast({ event: 'update', data: { at: Date.now() } });
  return reply.json({ delivered: hub.size });
});
```

`hub.size` is the live subscriber count, which is handy for a readiness or metrics
endpoint. Call `hub.closeAll()` on shutdown to close every stream and stop the hub's
cleanup timer.

## API reference

### `createSSEStream(request, options?): SSEChannel`

### `createSSEHub(options?): SSEHub`

| `SSEHub` member | Description |
| --- | --- |
| `subscribe(request, options?)` | Adds a client, returns its `SSEChannel`. |
| `broadcast(event)` | Sends an `SSEEvent` to every open channel. |
| `broadcastData(data)` | Shorthand for `broadcast({ data })`. |
| `size` | Number of connected clients. |
| `closeAll()` | Closes all channels and stops the cleanup timer. |

| `SSEChannel` member | Description |
| --- | --- |
| `send(event)` | Sends one `SSEEvent`. |
| `sendData(data)` | Shorthand for `send({ data })`. |
| `close()` | Ends the stream. |
| `response` | The `Response` to return from the handler. |
| `open` | `false` once the client disconnects or `close()` was called. |
| `lastActivity` | Timestamp of the last send, used for idle cleanup. |

### `SSEEvent`

| Field | Maps to | Notes |
| --- | --- | --- |
| `data` | `data:` | Required. Non-strings are JSON-stringified. |
| `event` | `event:` | Optional event name the client listens for. |
| `id` | `id:` | Optional. Enables the browser's `Last-Event-ID` resume. |
| `retry` | `retry:` | Optional reconnect delay hint, in ms. |

### `SSEStreamOptions`

| Option | Default | Notes |
| --- | --- | --- |
| `pingInterval` | `30000` | Comment-frame keepalive. Stops proxies idling the connection out. |
| `headers` | none | Extra response headers. |
| `onClose` | none | Called when the client disconnects. |

### `SSEHubOptions`

| Option | Default | Notes |
| --- | --- | --- |
| `maxIdleMs` | `300000` | A channel idle longer than this is closed automatically. |
| `cleanupIntervalMs` | `60000` | How often the idle sweep runs. |

## Consuming it from a browser

```javascript
const source = new EventSource('/events');
source.addEventListener('update', (e) => {
  console.log(JSON.parse(e.data));
});
```

`EventSource` reconnects on its own. If you set `id` on your events, the browser sends
`Last-Event-ID` on reconnect so you can resume from where it left off.

## Notes and limits

- **Keepalive frames are real traffic.** A subscriber that connects and waits will
  receive `: ping` comment frames before any of your events. Parsers that assume every
  frame carries `data:` will need to skip them. `EventSource` handles this for you.
- **SSE is server to client only.** For bidirectional traffic use `app.ws()`, which today
  is supported on Node (via `serve()`, requires `npm i ws`) and Bun (via
  `@celsian/adapter-bun`), and not yet on Deno or Cloudflare Workers.
- **Serverless platforms cap response duration.** A long-lived SSE stream conflicts with
  function timeouts. SSE is best suited to a long-running server target (Node, Bun, Deno,
  Fly, Railway, Docker) rather than Lambda or Vercel serverless functions.
