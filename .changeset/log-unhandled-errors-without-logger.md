---
"@celsian/core": patch
---

A thrown error is now written to `console.error` when the app has no logger. `createApp()` without a `logger` option logs nothing, and in production the 500 response is sanitized as well, so an unhandled error left no trace anywhere. Any error answered with a 5xx by the default error handler now prints one line with the method, path and status, followed by the error and its stack:

```
[celsian] GET /orders/7 failed with 500: Error: connect ECONNREFUSED ...
```

4xx errors (`HttpError` below 500, validation failures, 404s) are not printed. Apps with a logger are unchanged: the error goes to the logger as `request error`, once. Nothing is printed when your own `setErrorHandler` or `onError` hook returns the response.
