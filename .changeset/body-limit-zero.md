---
"@celsian/core": patch
---

`bodyLimit: 0` now disables the body limit for JSON and text bodies that declare their length, as documented. A request with a `Content-Length` header, which is nearly every request with a body, was answered `413 Payload Too Large` because its declared length was compared with the limit of 0. Form, multipart and custom-parser bodies, and uploads with no declared length, were already accepted.
