---
"@celsian/core": patch
---

Report the client's host to WebSocket handlers, not the bind address.

The upgrade gate already resolved the real host, so this was never an
authentication bypass. But the `CelsianRequest` handed to `handler.open` was
still built from the URL composed out of the address the server BOUND to, which
`serve()` sets to the wildcard `0.0.0.0` under `NODE_ENV=production`. Any handler
that dispatches on host, which is how a multi-tenant app routes, saw
`http://0.0.0.0:3000/chat` for every tenant:

```
before: {"urlSeenByHandler":"http://0.0.0.0:5701/chat"}
after:  {"urlSeenByHandler":"http://app.example.com/chat"}
```

The other adapters were checked and are unaffected: `adapter-cloudflare`,
`adapter-lambda`, `adapter-deno` and `adapter-vercel` all dispatch through
`app.handle()`, which resolves the host already.
