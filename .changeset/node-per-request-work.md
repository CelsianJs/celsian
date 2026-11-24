---
"@celsian/core": patch
---

Less work per request on Node. Nothing in your routes, hooks or plugins needs to change.

Measured by counting, not timing (20,000 sequential requests against `serve()`, Node 22):

| Request | Promises created, before → after | Young-generation GCs, before → after |
|---|---|---|
| JSON `GET` | 24 → 3 | 1,015 → 391 |
| JSON `GET` with `cors()` and `security()` registered | 41 → 3 | 1,543 → 489 |
| JSON `POST` with a body | 59 → 22 | 1,525 → 685 |
| Route with params | 24 → 3 | 1,031 → 404 |
| 404 | 27 → 3 | 1,095 → 544 |
| Handler that throws | 37 → 3 | 1,312 → 638 |

What changed:

- **`cors()`, `security()` and any `onSend` hook that sets a header no longer cost the fast response path.** Their headers used to force a second `Response` around the first one's body, which the Node server then drained from a stream and sent chunked. Responses from `reply.json()`, `reply.send()`, `reply.html()` and returned values now keep their single write whatever hooks add.
- **A request that does nothing asynchronous is answered synchronously.** Hooks and handlers are only awaited when they return a promise, `GET` and `HEAD` skip body parsing without a tick, and the request timeout only sets its timer once a request has actually gone asynchronous. The timeout itself is one timer instead of a `Promise.race`.
- **`reply` methods and `request.cookies` live on prototypes** instead of being 27 closures and a `defineProperty` per request. Destructuring (`const { json } = reply`), keeping a reference to wrap a method, and assigning a replacement all work as before.
- **`request.signal` is built when you first read it**, on `serve()` and for the request timeout alike. It still aborts when the client disconnects and when the request times out.
- **The built-in error, 404 and 405 responses are written in one go**, like any other JSON response.
- **On `serve()`, a request body is read from Node's own stream** rather than through the web streams wrapped around it. `request.bodyUsed`, `request.text()` and `request.clone()` behave exactly as they do after any body has been read.
- **Route schemas are adapted once, at registration**, and static routes are matched without splitting the path.

Things you could notice:

- `reply`'s methods, `reply.headers`, `request.cookies` and `request.signal` are no longer own properties. `Object.keys(reply)` lists only `statusCode` and `sent`, and `{ ...reply }` or `{ ...request }` no longer copies them. Reading, destructuring, `in` and `for...in` are unchanged.
- The built-in error, 404 and 405 responses, and responses that gain headers in `onSend`, now carry `Content-Length` on Node instead of `Transfer-Encoding: chunked`. Statuses, bodies and headers are otherwise the same.
- With no asynchronous hook in front of it, a handler now starts inside the `app.handle()` call rather than one microtask later. `app.handle()` still always returns a promise.

`@celsian/adapter-node` uses the same response writer, so it also keeps the single write when hooks add headers. It still reads bodies and builds `request.signal` as before.
