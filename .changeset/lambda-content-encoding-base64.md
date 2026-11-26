---
"@celsian/adapter-lambda": patch
---

Compressed responses are no longer corrupted on Lambda. The adapter chose between a text body and a base64 body from `content-type` alone, so a response from `@celsian/compress` (`application/json` with `content-encoding: gzip`) was decoded as UTF-8 text and returned with `isBase64Encoded: false`. The client received a body labelled gzip that would not decompress. Any response with a `content-encoding` header is now returned base64-encoded with `isBase64Encoded: true`, for API Gateway HTTP API, REST API and ALB events.
