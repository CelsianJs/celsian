---
"@celsian/core": patch
---

A header added to a response after it was built is now sent by the Node server. Responses from `reply.json()`, `reply.send()`, `reply.html()` and auto-serialized return values were written from a snapshot of their headers taken at creation, so this lost the header on a real server while `app.inject()`, Bun, Deno and Workers all showed it:

```ts
app.get('/x', (_req, reply) => {
  const res = reply.json({ ok: true });
  res.headers.set('x-late', '1'); // present in inject(), missing from serve()
  return res;
});
```

The same applied to code that wraps `app.handle()` to add headers, and to headers replaced, deleted or appended (`set-cookie`) afterwards. The Node writer now uses the response's own headers whenever they have been read since it was built. Responses nobody touched are written exactly as before, with no added per-request work. This also applies to `@celsian/adapter-node`, which uses the same writer.
