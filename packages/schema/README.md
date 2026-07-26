# CelsianJS Schema

Schema utilities for CelsianJS applications. Adapts Zod, TypeBox, and Valibot to
one internal interface so routes and RPC procedures can accept any of them.

This package is part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root repository README for framework documentation, examples, and release notes.

## Installation

```bash
npm install @celsian/schema
```

All three schema libraries are **optional** peer dependencies. Install only the
one you use.

## Usage

```ts
import { fromSchema } from '@celsian/schema';

const schema = fromSchema(z.object({ name: z.string() })); // or Type.Object / v.object
const result = schema.validate(input);
if (result.success) {
  result.data; // validated, unknown keys removed
} else {
  result.issues; // [{ message, path }]
}
```

`fromSchema()` detects the library by shape: TypeBox by its `TypeBox.Kind`
symbol, Zod by `safeParse` + `parse`, Valibot by `~standard`. It never silently
passes an unrecognized value through — it throws a `SchemaError` naming what it
received.

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
- Schemas that already set `additionalProperties: false` are unaffected — those
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
Async Valibot schemas are not supported by validate() — use a synchronous schema.
```

This is a known limitation, deliberately left in place rather than partially
worked around. Supporting async validation properly means threading an
awaitable result through every consumer of `StandardSchema` — including
`@celsian/core`'s route validation and `@celsian/rpc`'s input/output
validation — which is a cross-package change with its own release. Making only
one consumer async-capable would leave the two paths behaving differently for
the same schema, which is worse than the current honest refusal.

Workarounds today: keep the schema synchronous and do the async part (uniqueness
checks, remote lookups) in the handler, where you have the request context and
can return a proper error.

## License

MIT
