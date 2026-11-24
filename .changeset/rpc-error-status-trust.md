---
"@celsian/rpc": patch
"@celsian/core": patch
---

RPC no longer returns raw error messages for errors that happen to carry a `statusCode`. `RPCHandler` trusted `statusCode` on anything thrown, so a database or HTTP-client error with `statusCode: 400` was answered as a 400 and skipped production sanitization: its full message, connection string included, went to the client. A value outside the valid range (`statusCode: 99`) made `handle()` reject instead of answering, as did throwing `undefined` or `null`.

RPC now applies the rule `@celsian/core` already uses: only `HttpError` and `ValidationError` choose the status, code and message. Anything else is a 500, logged in full and sent as `Internal error` in production.

**If you throw plain errors with a `statusCode` from RPC procedures or middleware** (`Object.assign(new Error('nope'), { statusCode: 403 })`), they now produce a 500. Throw `new HttpError(403, 'nope')` from `@celsian/core` instead.

`@celsian/core` marks `HttpError` and `ValidationError` with a registered symbol so `@celsian/rpc`, which does not depend on core, can recognise them, including across duplicate installs. The `HttpError` of earlier core versions is still recognised.
