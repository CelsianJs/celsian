# @celsian/schema

Standard Schema adapters for [CelsianJS](https://github.com/CelsianJs/celsian). Wraps Zod, TypeBox, and Valibot behind one small interface so `@celsian/core` can validate request bodies and query strings, and emit JSON Schema for OpenAPI, without caring which library you use.

This package has no runtime dependencies. Bring your own schema library.

## Install

```bash
npm install @celsian/schema
```

You rarely install it directly: `@celsian/core` depends on it and auto-detects schemas you attach to routes. Install it when you want the adapters standalone.

## The interface

```ts
interface StandardSchema<Input, Output> {
  validate(input: unknown): { success: boolean; data?: Output; issues?: SchemaIssue[] };
  toJsonSchema(): Record<string, unknown>;
}
```

`validate()` never throws on invalid input; it returns `success: false` with `issues` (each `{ message, path? }`). `toJsonSchema()` is what feeds the OpenAPI spec.

> **JSON Schema output is TypeBox-only today.** TypeBox schemas *are* JSON Schema, so they convert losslessly. The Zod adapter only forwards to a `toJsonSchema()` method on the schema itself (which Zod does not provide), and the Valibot adapter does not convert at all, so both currently return a bare `{ type: 'object' }` with no `properties`. Validation works fully for all three; it is only the OpenAPI/JSON-Schema *output* that degrades. Use TypeBox if you want a detailed generated spec.

## Auto-detection

`fromSchema()` identifies the library by structure and returns the right adapter.

```ts
import { fromSchema } from '@celsian/schema';
import { z } from 'zod';

const schema = fromSchema<{ name: string }>(z.object({ name: z.string() }));

schema.validate({ name: 'Ada' });  // { success: true,  data: { name: 'Ada' } }
schema.validate({ name: 42 });     // { success: false, issues: [ { message, path } ] }
schema.toJsonSchema();             // { type: 'object' }  (see the note above)
```

With TypeBox you get the full shape:

```ts
import { fromSchema } from '@celsian/schema';
import { Type } from '@sinclair/typebox';

fromSchema(Type.Object({ name: Type.String() })).toJsonSchema();
// { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }
```

Detection order: an existing `StandardSchema` (returned unchanged), TypeBox (by its `Symbol.for('TypeBox.Kind')`), Zod (`safeParse` + `parse`), Valibot (`~standard` / `~run` / `_parse`), then a plain JSON Schema object as a fallback. Anything else throws `SchemaError`.

## Explicit adapters

Skip detection when you already know the library:

```ts
import { fromZod, fromTypeBox, fromValibot } from '@celsian/schema';
import { z } from 'zod';
import { Type } from '@sinclair/typebox';
import * as v from 'valibot';

const a = fromZod<{ id: number }>(z.object({ id: z.number() }));
const b = fromTypeBox<{ id: number }>(Type.Object({ id: Type.Number() }));
const c = fromValibot<{ id: number }>(v.object({ id: v.number() }));
```

All three produce the same `StandardSchema` shape and validate equivalently. Only `fromTypeBox` emits a detailed `toJsonSchema()`.

## Query-string coercion

Query params arrive as strings. `coerceString` and `coerceQueryParams` convert them before validation.

```ts
import { coerceString, coerceQueryParams } from '@celsian/schema';

coerceString('42', 'number');        // 42
coerceString('true', 'boolean');     // true
coerceString('2026-01-01', 'date');  // Date

coerceQueryParams(
  { page: '2', active: 'true', q: 'shoes' },
  { page: 'number', active: 'boolean', q: 'string' },
);
// { page: 2, active: true, q: 'shoes' }
```

Both throw `TypeError` on a value that cannot be coerced. `'1'`/`'0'` also count as booleans, and an empty string is `false`.

## Use with routes

In an app you normally do not touch this package at all: attach the schema and `@celsian/core` runs the adapter for you.

```ts
import { createApp } from '@celsian/core';
import { Type } from '@sinclair/typebox';

const app = createApp();

app.post('/users', {
  schema: { body: Type.Object({ name: Type.String() }) },
}, (req, reply) => reply.status(201).json(req.parsedBody));
```

Invalid bodies get a 400 before the handler runs, and the schema shows up in the OpenAPI spec.

## Unknown keys are stripped, in every library

The same logical schema behaves the same way whichever library you write it in:
properties the schema does not declare are **removed** from `result.data`.

```ts
const input = { name: 'a', isAdmin: true };

fromSchema(z.object({ name: z.string() })).validate(input).data;        // { name: 'a' }
fromSchema(v.object({ name: v.string() })).validate(input).data;        // { name: 'a' }
fromSchema(Type.Object({ name: Type.String() })).validate(input).data;  // { name: 'a' }
```

**This is a deliberate divergence from TypeBox's own default.** TypeBox lets
unknown keys through unless the schema sets `additionalProperties: false`; Zod
and Valibot strip them. Because Celsian presents all three as interchangeable
behind one `fromSchema()`, that difference meant swapping libraries silently
changed whether `db.user.update({ data: validated })` was a mass-assignment
hole. The adapter therefore calls `Value.Clean` after validation.

Notes:

- Validation never mutates your input object; the cleaned value is a clone.
- Stripping applies at every level, including nested objects and array elements.
- Schemas that already set `additionalProperties: false` are unaffected, those
  inputs fail validation before any cleaning happens.

To keep raw TypeBox semantics:

```ts
fromTypeBox(schema, { stripUnknown: false });
fromSchema(schema, { typebox: { stripUnknown: false } });
```

## Type inference

`InferOutput<T>` reads whichever carrier the library uses: `_output` (Celsian
adapters, Zod v3), `_type` (legacy TypeBox and similar), or `static`
(TypeBox 0.30+, including 0.34). TypeBox is what `create-celsian` scaffolds by
default, so the `static` branch is what makes `parsedBody` genuinely typed there
rather than `unknown`.

## `StandardSchema` is not `@standard-schema/spec`

The exported `StandardSchema` interface (`validate()` + `toJsonSchema()`) is
**Celsian's own internal adapter shape**, despite the name. It is not the
[Standard Schema](https://standardschema.dev) specification, which uses a
`~standard` property. Celsian *detects* real Standard Schema implementations via
`~standard` (that is how modern Valibot is routed), but it adapts them into this
local interface rather than consuming the spec directly. Adopting
`@standard-schema/spec` as the actual public contract is a deliberate future
change, not something this interface already does.

## Async validation is not supported

`validate()` is synchronous and returns `SchemaResult`, not a promise. Async
schemas (Valibot's `checkAsync` / async pipe actions, Zod's `parseAsync`-only
refinements) cannot be evaluated through it. The Valibot adapter detects this
case and fails loudly rather than returning a bogus result or leaving a dangling
promise:

```
Async Valibot schemas are not supported by validate(); use a synchronous schema.
```

This is a known limitation, deliberately left in place rather than partially
worked around. Supporting async validation properly means threading an
awaitable result through every consumer of `StandardSchema`, including
`@celsian/core`'s route validation and `@celsian/rpc`'s input/output
validation, which is a cross-package change with its own release. Making only
one consumer async-capable would leave the two paths behaving differently for
the same schema, which is worse than the current honest refusal.

Workarounds today: keep the schema synchronous and do the async part (uniqueness
checks, remote lookups) in the handler, where you have the request context and
can return a proper error.

## Exports

`fromSchema`, `fromZod`, `fromTypeBox`, `fromValibot`, `coerceString`, `coerceQueryParams`, `SchemaError`, and the types `StandardSchema`, `SchemaResult`, `SchemaIssue`, `InferOutput`.

## License

MIT
