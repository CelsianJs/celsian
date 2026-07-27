---
"@celsian/schema": patch
"@celsian/core": patch
"@celsian/rpc": patch
---

fix(schema,core,rpc): generate real JSON Schema for Zod and Valibot in OpenAPI

OpenAPI generation was materially broken for the two schema libraries nearly
every example uses.

- `@celsian/schema` now converts Zod (v3 and v4) and Valibot schemas to JSON
  Schema by reading their internal representations, with no new dependency and
  without importing either optional peer at runtime. Both adapters previously
  answered `{ type: "object" }` for every schema, so a documented request body
  had zero documented fields.
- The OpenAPI plugin runs schemas through the adapters before any structural
  guess. Valibot object schemas natively carry `type: "object"`, so the previous
  `"type" in schema` shortcut published Valibot's raw internal AST (`kind`,
  `expects`, `entries`, `~standard`) into the document verbatim.
- A bare (non-status-keyed) `schema.response` is now recognised with the same
  `isStatusKeyedResponseMap` guard the runtime validator uses. It used to be
  iterated as a status map, so `response: z.object({...})` emitted roughly 29
  responses named after the schema instance's own methods (`spa`, `_def`,
  `parse`, `safeParse`, `refine`, …), producing an invalid document.
- `schema.querystring` now reaches the spec as query parameters for all three
  libraries; it produced nothing whenever the schema converted to a property-less
  object.
- `RPCHandler.generateOpenAPI()` inherits the same fix, and a query procedure's
  `input` parameter now documents its real shape via `content` instead of an
  uninformative `schema: { type: "string" }`.
