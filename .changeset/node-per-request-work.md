---
"@celsian/core": patch
---

Less work per request on Node. Nothing in your routes, hooks or plugins needs to change.

Measured by counting, not timing (20,000 sequential requests against `serve()`, Node 22.13.1, with `pnpm test:alloc`: "before" is the median of three runs against 0.6.7's built `@celsian/core`, "after" of ten against this release's). A handler declared `async` costs more than one that returns its value directly, so both are shown:

| Request | Promises created, before → after | Young-generation GCs, before → after |
|---|---|---|
| JSON `GET`, synchronous handler | 24 → 3 | 1,024 → 392 |
| JSON `GET`, `async` handler | 24 → 8 | 1,027 → 430 |
| JSON `GET` with `cors()` and `security()` registered | 41 → 3 | 1,542 → 487 |
| JSON `POST` with a body, synchronous handler | 59 → 16 | 1,521 → 654 |
| JSON `POST` with a body, `async` handler | 59 → 19 | 1,541 → 675 |
| Route with params | 24 → 3 | 1,031 → 405 |
| 404 | 27 → 3 | 1,090 → 545 |
| Handler that throws (production) | 37 → 3 | 1,226 → 431 |

An `async` handler adds five promises and a timer: its own promise, the one that waits for it, the request timeout's timer and two promises, and the server's wait for the answer. A request answered synchronously sets up none of them. Three of every count are inside `new Response()`. For comparison, measured the same way, with the same handler style, the same response headers and a body of the same size, Fastify creates 0 promises for the synchronous `GET` and 2 for the `async` one, and Hono 3 and 10.

What changed:

- **`cors()`, `security()` and any `onSend` hook that sets a header no longer cost the fast response path.** Their headers used to force a second `Response` around the first one's body, which the Node server then drained from a stream and sent chunked. Responses from `reply.json()`, `reply.send()`, `reply.html()` and returned values now keep their single write whatever hooks add.
- **A request that does nothing asynchronous is answered synchronously.** Hooks and handlers are only awaited when they return a promise, `GET` and `HEAD` skip body parsing without a tick, and the request timeout only sets its timer once a request has actually gone asynchronous. The deadline is still counted from the start of the request. The timeout itself is one timer instead of a `Promise.race`.
- **A request that is asynchronous is waited on fewer times.** The lifecycle, the timeout and the Node server each used to wait on the same answer in turn.
- **`reply` methods and `request.cookies` live on prototypes** instead of being 27 closures and a `defineProperty` per request. Destructuring (`const { json } = reply`), keeping a reference to wrap a method, assigning a replacement, and wrapping a reply with `Object.create(reply)` or a transparent `Proxy` all work as before. What is and is not supported when you wrap or inspect `reply` and `request` is now written down in `@celsian/core`'s README, under "Wrapping and inspecting `reply` and `request`", with a test for each statement.
- **`request.signal` is built when you first read it**, on `serve()` and for the request timeout alike. It still aborts when the client disconnects and when the request times out.
- **The built-in error, 404 and 405 responses are written in one go**, like any other JSON response.
- **On `serve()`, a request body is read from Node's own stream** rather than through the web streams wrapped around it, and a JSON or text body is parsed as the stream ends. `request.bodyUsed`, `request.text()` and `request.clone()` behave exactly as they do after any body has been read.
- **Route schemas are adapted once, at registration**, and static routes are matched without splitting the path.

Fixed along the way:

- **A listener left on `request.signal` no longer keeps the request in memory, and neither does a long-lived input signal.** `request.signal` was built with `AbortSignal.any()`, and Node holds on to such a signal for as long as it has an `abort` listener. A handler that added one without `{ once: true }` and never removed it kept the signal alive for the life of the process, with the whole request if the listener referred to it, and on Node 20 with the connection of every client that disconnected mid-request. On Node and Bun, `request.signal` is now a plain `AbortController`'s, which hears its input's abort through a relay made with `AbortSignal.any([input])` that only core listens on. The relay refers to `request.signal` only weakly and is dropped once the signal aborts or is collected, so no input signal keeps a finished request alive, not even one input shared by many requests (the same `Request` dispatched over and over). No other listener on the input can stop the abort from arriving, now on every Node from 20.3, including 20.5 to 20.15, where `events.addAbortListener()` cannot be reached synchronously and an earlier listener calling `stopImmediatePropagation()` used to keep it from `request.signal`. On Deno and Cloudflare Workers `request.signal` is `AbortSignal.any()` of the input and the timeout, as before.
- **An `abort` event dispatched on the input signal no longer aborts `request.signal`.** `input.signal.dispatchEvent(new Event("abort"))` on a signal that has not aborted used to abort `request.signal` with a default `AbortError` and lose the input's real abort afterwards. Now only a real abort counts, and it carries the input's reason.
- **A `Transfer-Encoding` set on the reply frames the body, and no `Content-Length` goes with it.** `reply.header("transfer-encoding", "chunked").send("hello")` went out with both headers, which Node's own client refuses (`HPE_INVALID_CONTENT_LENGTH`); since the fast path began keeping responses that hooks add headers to, the same happened with `cors()` and `security()` and on error answers. A coding that does not end in `chunked` now also closes the connection after the body, the only way such a body can end. On Node, a fast response's other framing is now: a body is sent with the `Content-Length` of its bytes, replacing any set on the reply; with no body, a `Content-Length` set on the reply is dropped and `Content-Length: 0` sent (it used to be sent as set, and the client waited for bytes that never came), except on a HEAD answer and a 304, where it describes the content; a 204 carries neither `Content-Length` nor `Transfer-Encoding`. `Connection` and `Upgrade` are passed through.
- **A header value outside ASCII is sent as the bytes it was set with.** `reply.header("x-name", "café")` on a `reply.json()`, `reply.send()` or `reply.html()` response went out UTF-8 encoded (`c3 a9`) where `inject()` and every other runtime report latin-1 (`e9`).
- **A response with no body carries `Content-Length: 0`.** `reply.send(null)` under a 200 went out as `Transfer-Encoding: chunked` with an empty chunk.

Things you could notice:

- `reply`'s methods, `reply.statusCode`, `reply.sent`, `reply.headers`, `request.cookies` and `request.signal` are no longer own properties. `Object.keys(reply)` lists only your decorations, and `{ ...reply }` or `{ ...request }` no longer copies the rest. Reading, assigning, destructuring, `in` and `for...in` are unchanged, and so is `JSON.stringify(reply)`, which the reply now answers through a `toJSON()` method.
- A method read off a reply (`reply.json`) is a function bound to that reply: its `name` is `"bound"` rather than `"json"` and its `length` is 3 whatever the method takes.
- The `Request` that `serve()` builds is an instance of a `Request` subclass, so its `constructor.name` is `"NodeRequest"`. Any route sees it as what `request.clone()` returns, and an app that replaced or overrode `app.handle` is handed one. `instanceof Request` is still true. (`inject()` and the other runtimes still use plain `Request`s.)
- The built-in error, 404 and 405 responses, and responses that gain headers in `onSend`, now carry `Content-Length` on Node instead of `Transfer-Encoding: chunked`. Statuses, bodies and header values are otherwise the same.
- When a hook adds a header or a cookie to a fast response, the response's own header values are sent as `Headers` holds them, whitespace at either end removed, as when the response was rebuilt through `Headers`; with no hook a value is sent as it was set, as before.
- On Node, those same responses now send their headers in the order they were set, `content-type` first, where they used to be sorted by name (they went through a `Headers` object): a 405 sends `allow` after `content-type`, and `cors()` and `security()` headers come after the route's own. Header order has no meaning in HTTP, but a test that compares raw header blocks will see it.
- In development, the stack in the body of a 500 for an error thrown after an `await` in an `async` handler ends at the handler. It used to go on through `async CelsianApp.runLifecycle`, `async CelsianApp.handle` and the caller, frames V8 only records across `await`, and the lifecycle no longer awaits the handler. The error's own message and the handler's frame are unchanged, and production bodies carry no stack at all.
- **A request already past its deadline when it first waits is answered 504 unless it settles on promises alone.** A timer cannot interrupt synchronous work, so a hook or handler that works past `requestTimeout` before it waits is decided at that wait. If it then settles on promises (microtasks) or a `process.nextTick`, it answers as before. If it waits on anything the event loop has to come round for (an immediate, a timer, I/O), it now gets the 504 before what it waits on runs, and resumes with `request.signal` aborted with the 504 error. In 0.6.7 the timer was set when the lifecycle began, after the first `onRequest` hook's synchronous work, and fired only when the event loop reached timers, so such a request could still answer 200. Measured over a real socket with `requestTimeout: 15` and 40 ms of synchronous work (`timeout-overrun.test.ts` pins the "now" column):

  | After 40 ms of synchronous work, past a 15 ms deadline, the request | 0.6.7 | now |
  |---|---|---|
  | answers without waiting | 200 | 200 |
  | waits only on promises | 200 | 200 |
  | waits on a `process.nextTick` | 200 | 200 |
  | waits on `setImmediate` | 200 | 504 |
  | waits on a timer or on I/O, in the handler | 504 | 504 |
  | waits on a timer or on I/O, in an `onRequest` hook | 200 | 504 |
  | called `reply.send()` first, then waits on promises | 200 | 200 |
  | called `reply.send()` first, then waits on `setImmediate` | 200 | 504 |
  | returned a streamed `Response` at once, whose producer then works 40 ms | 200 | 200 |
  | first of two pipelined requests, waiting on `setImmediate` (the second answers at once) | 200, 200 | 504, 200 |

  Pipelined requests still get one response each, in order. The deadline covers the lifecycle, not a streamed body. It also now includes the synchronous work of the first `onRequest` (or `preParsing`) hook, which ran before the timer used to be set.
- With no asynchronous hook in front of it, a handler now starts inside the `app.handle()` call rather than one microtask later. `app.handle()` still always returns a promise.
- **On Node and Bun, `request.signal` aborts just after the input signal's own `abort` listeners have run**, so inside one of them `request.signal.aborted` is still `false`. With `AbortSignal.any()` it was already `true` there on Node 22 and later (and `false` on Node 20). Only a signal made by `AbortSignal.any()` gets that ordering, and it is the one Node keeps alive with its listeners. Deno and Cloudflare Workers keep the old ordering.
- **Where one input signal is shared by several requests**, a request's signal now lives only as long as something holds it: a stream that refers to it still sees the abort, but a signal that only has listeners may be collected before they run. Where each request has a signal of its own (every runtime's `Request`, `serve()`'s connections), the input keeps the request's signal alive as before, and a listener on it alone still runs after the handler returned.
- **A `Proxy` whose `get` trap hides symbol-keyed properties, and a membrane (a proxy that wraps every value it returns), no longer reach the reply**: through one, `statusCode`, `sent` and every method read as `undefined`. In 0.6.7, when every method was a closure of its own, they worked. Making them work again was measured with per-instance accessors for `statusCode` and `sent` alone: 176 to 880 bytes per reply and 12 to 14% more young-generation GCs in every scenario of the allocation gate, which then fails, so it is not done.
- `structuredClone(reply)` now gives a plain object with the reply's decorations (it threw a `DataCloneError` in 0.6.7, and still does when a decoration or an assigned method is a function). A spread of the reply also carries a few symbol-keyed fields internal to core. Assigning to the property a reply holds itself in (found through `Object.getOwnPropertySymbols()`) throws a `TypeError`; copying a reply's symbol-keyed properties onto another object is not supported.
- `serve()` reads `app.handle` once per request and calls what it read, with the app as `this`, so an accessor is asked once.

`@celsian/adapter-node` uses the same response writer, so it also keeps the single write when hooks add headers, and gets the header-bytes, `Content-Length: 0` and `Transfer-Encoding` fixes. It still reads bodies and builds the input `Request`'s signal as before.
