---
"@celsian/schema": patch
---

OpenAPI and JSON Schema output keeps Zod constraints on Zod 4.6 and later. Zod 4.6 stopped recording `min`, `max`, `length`, `multipleOf`, formats such as `email` and `uuid`, and regex patterns in the place `zodToJsonSchema` read them from, so with the patched Zod (4.6.6 or later, required by GHSA-mrhx-c7xc-m3w5) every constrained field was published as a bare `{ "type": "string" }` or `{ "type": "number" }`, with no error. The converter now reads the constraints from the schema's checks, which works on every Zod 4 release. Request validation was never affected; only the generated documents were.

Exclusive bounds are now published too: `z.number().gt(0)`, `.lt(10)`, `.positive()` and `.negative()` emit `exclusiveMinimum` / `exclusiveMaximum`. They were previously left out of the document on every Zod 4 version.

The examples (`auth-flow`, `quickstart`, `saas-demo`, `showcase`) now depend on `zod@^4.6.7`. The `zod` peer range of `@celsian/schema` is unchanged (`>=3.0.0`).
