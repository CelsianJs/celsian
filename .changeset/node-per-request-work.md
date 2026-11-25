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
- **A request that does nothing asynchronous is answered synchronously.** Hooks and handlers are only awaited when they return a promise, `GET` and `HEAD` skip body parsing without a tick, and the request timeout only sets its timer once a request has actually gone asynchronous. The deadline is still counted from the start of the request, and a request already past it by then is answered 504 before anything it waits on gets to run, as when the timer was set first. The timeout itself is one timer instead of a `Promise.race`.
- **A request that is asynchronous is waited on fewer times.** The lifecycle, the timeout and the Node server each used to wait on the same answer in turn.
- **`reply` methods and `request.cookies` live on prototypes** instead of being 27 closures and a `defineProperty` per request. Destructuring (`const { json } = reply`), keeping a reference to wrap a method, assigning a replacement, and wrapping a reply with `Object.create(reply)` or a `Proxy` all work as before.
- **`request.signal` is built when you first read it**, on `serve()` and for the request timeout alike. It still aborts when the client disconnects and when the request times out.
- **The built-in error, 404 and 405 responses are written in one go**, like any other JSON response.
- **On `serve()`, a request body is read from Node's own stream** rather than through the web streams wrapped around it, and a JSON or text body is parsed as the stream ends. `request.bodyUsed`, `request.text()` and `request.clone()` behave exactly as they do after any body has been read.
- **Route schemas are adapted once, at registration**, and static routes are matched without splitting the path.

Fixed along the way:

- **A listener left on `request.signal` no longer keeps the request in memory.** `request.signal` was built with `AbortSignal.any()`, and Node holds on to such a signal for as long as it has an `abort` listener. A handler that added one without `{ once: true }` and never removed it kept the signal alive for the life of the process, with the whole request if the listener referred to it, and on Node 20 with the connection of every client that disconnected mid-request. On Node and Bun the signal is now a plain `AbortController`'s, following the connection through `events.addAbortListener()`, which no other listener can stop. Elsewhere, without such a listener (Deno's `addAbortListener()` is an ordinary one), it is built with `AbortSignal.any()` as before.
- **A header value outside ASCII is sent as the bytes it was set with.** `reply.header("x-name", "café")` on a `reply.json()`, `reply.send()` or `reply.html()` response went out UTF-8 encoded (`c3 a9`) where `inject()` and every other runtime report latin-1 (`e9`).
- **A response with no body carries `Content-Length: 0`.** `reply.send(null)` under a 200 went out as `Transfer-Encoding: chunked` with an empty chunk.

Things you could notice:

- `reply`'s methods, `reply.statusCode`, `reply.sent`, `reply.headers`, `request.cookies` and `request.signal` are no longer own properties. `Object.keys(reply)` lists only your decorations, and `{ ...reply }` or `{ ...request }` no longer copies the rest. Reading, assigning, destructuring, `in` and `for...in` are unchanged, and so is `JSON.stringify(reply)`, which the reply now answers through a `toJSON()` method.
- A method read off a reply (`reply.json`) is a function bound to that reply: its `name` is `"bound"` rather than `"json"` and its `length` is 3 whatever the method takes.
- The `Request` that `serve()` builds is an instance of a `Request` subclass, so its `constructor.name` is `"NodeRequest"`. Any route sees it as what `request.clone()` returns, and an app that replaced or overrode `app.handle` is handed one. `instanceof Request` is still true. (`inject()` and the other runtimes still use plain `Request`s.)
- The built-in error, 404 and 405 responses, and responses that gain headers in `onSend`, now carry `Content-Length` on Node instead of `Transfer-Encoding: chunked`. Statuses, bodies and header values are otherwise the same.
- On Node, those same responses now send their headers in the order they were set, `content-type` first, where they used to be sorted by name (they went through a `Headers` object): a 405 sends `allow` after `content-type`, and `cors()` and `security()` headers come after the route's own. Header order has no meaning in HTTP, but a test that compares raw header blocks will see it.
- In development, the stack in the body of a 500 for an error thrown after an `await` in an `async` handler ends at the handler. It used to go on through `async CelsianApp.runLifecycle`, `async CelsianApp.handle` and the caller, frames V8 only records across `await`, and the lifecycle no longer awaits the handler. The error's own message and the handler's frame are unchanged, and production bodies carry no stack at all.
- The request timeout's deadline now includes the synchronous work of the first `onRequest` (or `preParsing`) hook, which ran before the timer used to be set.
- With no asynchronous hook in front of it, a handler now starts inside the `app.handle()` call rather than one microtask later. `app.handle()` still always returns a promise.

`@celsian/adapter-node` uses the same response writer, so it also keeps the single write when hooks add headers, and gets the header-bytes and `Content-Length: 0` fixes. It still reads bodies and builds `request.signal` as before.
