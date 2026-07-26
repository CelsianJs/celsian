---
"@celsian/core": minor
"@celsian/queue-redis": minor
"@celsian/schema": patch
"@celsian/rpc": patch
---

Fix the public type surface exposed by turning the typecheck gate on over test files.

**@celsian/core**

- `CelsianRequest.cookies` is now declared. It is defined on every request by the app itself, not by a plugin, but it was reachable only through the plugin index signature, so `req.cookies.session` arrived as `unknown` and every caller had to cast.
- The dead-letter and task-durability types are now exported: `DeadLetterCapableQueue`, `DeadLetterEntry`, `TaskFailure`, `TaskFailureInfo`, `ServerlessCronRuntime`, plus the `DEFAULT_VISIBILITY_TIMEOUT`, `DEFAULT_TASK_TIMEOUT`, and `detectServerlessCronRuntime` values. Implementing a custom queue backend previously required re-declaring them by hand.

**@celsian/queue-redis**

- `QueueMessage`, `TaskFailure`, and `DeadLetterEntry` are exported. `TaskFailure` and `DeadLetterEntry` were structural mirrors of core's types, kept locally only because core did not export them; they are now the real types re-exported from core, so a backend can no longer drift from the interface it implements.

**@celsian/schema**

- The Zod adapter accepts real Zod 4 schemas again. Its `ZodIssue.path` was declared `(string | number)[]` while Zod 4 produces `PropertyKey[]`, so `z.object(...)` did not satisfy `fromZod`'s parameter type. Symbol path segments are normalized to strings on the way out, leaving the published `SchemaIssue.path` contract unchanged.
- `fromZod` also accepts ordinary Zod-shaped objects again. Its result type was a union discriminated on the literals `true`/`false`, which no plain function return ever has (TypeScript widens `success` to `boolean`), so only Zod's own types could satisfy it. A failed parse that carries no error object now reports that instead of throwing on a missing property.

**@celsian/rpc**

- `createRPCClient<any>()` is usable again. `any` satisfied every branch of the client's conditional type at once, so the result was a union of all three branches and no property access on the client compiled.
