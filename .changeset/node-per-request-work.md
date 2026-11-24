---
"@celsian/core": patch
---

Less work per request on Node. Nothing in your routes, hooks or plugins needs to change.

Measured by counting, not timing (20,000 sequential requests against `serve()`, Node 22). A handler declared `async` costs more than one that returns its value directly, so both are shown:

| Request | Promises created, before → after | Young-generation GCs, before → after |
|---|---|---|
| JSON `GET`, synchronous handler | 24 → 3 | 1,022 → 394 |
| JSON `GET`, `async` handler | 24 → 8 | 1,027 → 430 |
| JSON `GET` with `cors()` and `security()` registered | 41 → 3 | 1,542 → 487 |
| JSON `POST` with a body, synchronous handler | 59 → 16 | 1,518 → 642 |
| JSON `POST` with a body, `async` handler | 59 → 19 | 1,542 → 677 |
| Route with params | 24 → 3 | 1,024 → 406 |
| 404 | 27 → 3 | 1,091 → 541 |
| Handler that throws (production) | 37 → 3 | 1,226 → 432 |

An `async` handler adds five promises and a timer: its own promise, the one that waits for it, the request timeout's timer and two promises, and the server's wait for the answer. A request answered synchronously sets up none of them. Three of every count are inside `new Response()`. For comparison, measured the same way, with the same handler style, the same response headers and a body of the same size, Fastify creates 0 promises for the synchronous `GET` and 2 for the `async` one, and Hono 3 and 10.

What changed:

- **`cors()`, `security()` and any `onSend` hook that sets a header no longer cost the fast response path.** Their headers used to force a second `Response` around the first one's body, which the Node server then drained from a stream and sent chunked. Responses from `reply.json()`, `reply.send()`, `reply.html()` and returned values now keep their single write whatever hooks add.
- **A request that does nothing asynchronous is answered synchronously.** Hooks and handlers are only awaited when they return a promise, `GET` and `HEAD` skip body parsing without a tick, and the request timeout only sets its timer once a request has actually gone asynchronous. The deadline is still counted from the start of the request. The timeout itself is one timer instead of a `Promise.race`.
- **A request that is asynchronous is waited on fewer times.** The lifecycle, the timeout and the Node server each used to wait on the same answer in turn.
- **`reply` methods and `request.cookies` live on prototypes** instead of being 27 closures and a `defineProperty` per request. Destructuring (`const { json } = reply`), keeping a reference to wrap a method, assigning a replacement, and wrapping a reply with `Object.create(reply)` all work as before.
- **`request.signal` is built when you first read it**, on `serve()` and for the request timeout alike. It still aborts when the client disconnects and when the request times out.
- **The built-in error, 404 and 405 responses are written in one go**, like any other JSON response.
- **On `serve()`, a request body is read from Node's own stream** rather than through the web streams wrapped around it, and a JSON or text body is parsed as the stream ends. `request.bodyUsed`, `request.text()` and `request.clone()` behave exactly as they do after any body has been read.
- **Route schemas are adapted once, at registration**, and static routes are matched without splitting the path.

Fixed along the way:

- **A listener left on `request.signal` no longer keeps the request in memory.** `request.signal` was built with `AbortSignal.any()`, and Node holds on to such a signal for as long as it has an `abort` listener. A handler that added one without `{ once: true }` and never removed it kept the signal alive for the life of the process, with the whole request if the listener referred to it, and on Node 20 with the connection of every client that disconnected mid-request. The signal is now a plain `AbortController`'s.
- **A header value outside ASCII is sent as the bytes it was set with.** `reply.header("x-name", "café")` on a `reply.json()`, `reply.send()` or `reply.html()` response went out UTF-8 encoded (`c3 a9`) where `inject()` and every other runtime report latin-1 (`e9`).
- **A response with no body carries `Content-Length: 0`.** `reply.send(null)` under a 200 went out as `Transfer-Encoding: chunked` with an empty chunk.

Things you could notice:

- `reply`'s methods, `reply.statusCode`, `reply.sent`, `reply.headers`, `request.cookies` and `request.signal` are no longer own properties. `Object.keys(reply)` lists only your decorations, and `{ ...reply }` or `{ ...request }` no longer copies the rest. Reading, assigning, destructuring, `in` and `for...in` are unchanged, and so is `JSON.stringify(reply)`, which the reply now answers through a `toJSON()` method.
- A method read off a reply (`reply.json`) is a function bound to that reply: its `name` is `"bound"` rather than `"json"` and its `length` is 3 whatever the method takes.
- The `Request` that `serve()` builds, which you only see if you replaced or overrode `app.handle`, is an instance of a `Request` subclass: `request.constructor.name` is `"NodeRequest"`. `request instanceof Request` is still true.
- The built-in error, 404 and 405 responses, and responses that gain headers in `onSend`, now carry `Content-Length` on Node instead of `Transfer-Encoding: chunked`. Statuses, bodies and headers are otherwise the same.
- With no asynchronous hook in front of it, a handler now starts inside the `app.handle()` call rather than one microtask later. `app.handle()` still always returns a promise.

`@celsian/adapter-node` uses the same response writer, so it also keeps the single write when hooks add headers, and gets the header-bytes and `Content-Length: 0` fixes. It still reads bodies and builds `request.signal` as before.
