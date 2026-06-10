# Error Reference

CelsianJS turns thrown errors into structured JSON responses. Every error response carries a machine-readable `code` so clients can branch on the error type without parsing human messages.

## Error response shape

A caught error is serialized to JSON with a consistent shape:

```json
{
  "error": "Not Found",
  "statusCode": 404,
  "code": "NOT_FOUND"
}
```

- `error` — a human-readable message. For 5xx errors in production, this is replaced with a generic message so internal details are not leaked.
- `statusCode` — the HTTP status, mirrored in the response status line.
- `code` — a stable, machine-readable string (the focus of this page).

Validation errors add an `issues` array, and in development a `stack` (and any `cause`) is included. See [Error Handling](../README.md#error-handling) for how to throw and customize errors.

```typescript
import { HttpError } from '@celsian/core';

throw new HttpError(403, 'Admin access required');
// { "error": "Admin access required", "statusCode": 403, "code": "FORBIDDEN" }

// Override the code explicitly:
throw new HttpError(409, 'Email already registered', { code: 'EMAIL_TAKEN' });
```

## Codes the framework emits

These codes come from CelsianJS itself — request parsing, routing, and validation — before your handler runs or when it throws a known error type.

| `code` | Status | Cause | Fix |
| ------ | -----: | ----- | --- |
| `VALIDATION_FAILED` | 400 | A request failed a route's `schema` (body, query, or params). The response includes an `issues` array with the failing paths. | Send input that matches the schema. Read `issues` to see which fields are wrong. |
| `INVALID_JSON` | 400 | The request had a JSON content-type but the body was not valid JSON. | Send well-formed JSON and a correct `Content-Type: application/json` header. |
| `INVALID_BODY` | 400 | The request body could not be parsed for its content-type (e.g. malformed form data). | Check the body encoding matches the `Content-Type`. |
| `MALFORMED_URI` | 400 | The request path contained invalid percent-encoding (e.g. `/%ZZ`). | Percent-encode path segments correctly (`encodeURIComponent`). |
| `NOT_FOUND` | 404 | No route matched the request path. | Check the path and method. Use `app.getRoutes()` to list registered routes. |
| `METHOD_NOT_ALLOWED` | 405 | The path matched a route, but not for this HTTP method. | Use a method the route defines. The `Allow` header lists permitted methods. |
| `PAYLOAD_TOO_LARGE` | 413 | The request body exceeded the configured `bodyLimit` (default 1 MB). | Reduce the payload, or raise `bodyLimit` in route/app config (`0` disables the check). |

## Codes from `HttpError`

When you `throw new HttpError(status, message)` without an explicit `code`, CelsianJS assigns a default code from the status. The same defaults are produced internally for known statuses.

| Status | Default `code` |
| -----: | -------------- |
| 400 | `BAD_REQUEST` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 408 | `REQUEST_TIMEOUT` |
| 409 | `CONFLICT` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `UNPROCESSABLE_ENTITY` |
| 429 | `TOO_MANY_REQUESTS` |
| 500 | `INTERNAL_SERVER_ERROR` |
| 502 | `BAD_GATEWAY` |
| 503 | `SERVICE_UNAVAILABLE` |
| 504 | `GATEWAY_TIMEOUT` |

Any status without a mapping defaults to `UNKNOWN_ERROR`. Pass `{ code: 'YOUR_CODE' }` to override.

## Codes from `reply` error helpers

The convenience methods on `reply` set both the status and a fixed code:

| Method | Status | `code` |
| ------ | -----: | ------ |
| `reply.badRequest()` | 400 | `BAD_REQUEST` |
| `reply.unauthorized()` | 401 | `UNAUTHORIZED` |
| `reply.forbidden()` | 403 | `FORBIDDEN` |
| `reply.notFound()` | 404 | `NOT_FOUND` |
| `reply.conflict()` | 409 | `CONFLICT` |
| `reply.gone()` | 410 | `GONE` |
| `reply.tooManyRequests()` | 429 | `TOO_MANY_REQUESTS` |
| `reply.internalServerError()` | 500 | `INTERNAL_SERVER_ERROR` |
| `reply.serviceUnavailable()` | 503 | `SERVICE_UNAVAILABLE` |

> `reply.internalServerError()` and `reply.serviceUnavailable()` replace the message with a generic one in production (`NODE_ENV=production`) so internal details are never leaked.

## Unhandled errors

If a handler throws something that is not an `HttpError` or `ValidationError` (a plain `Error`, or a thrown non-Error value), CelsianJS responds with status `500` and code `INTERNAL_SERVER_ERROR`. In production the message is `"Internal Server Error"`; in development the real message and stack are included to aid debugging.

To map your own errors to specific codes, register a custom handler:

```typescript
app.setErrorHandler((error, req, reply) => {
  if (error.message.includes('UNIQUE constraint')) {
    return reply.conflict('Resource already exists'); // code: CONFLICT
  }
  return reply.internalServerError();
});
```
