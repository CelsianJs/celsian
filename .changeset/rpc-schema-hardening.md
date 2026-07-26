---
"@celsian/rpc": minor
"@celsian/schema": minor
---

Harden the RPC surface and align schema-adapter behavior.

**@celsian/rpc**

- `decode()` no longer performs a real prototype assignment from client input. `JSON.parse` keeps `__proto__` as an own enumerable property, so copying it into a plain object fired `Object.prototype.__proto__`'s setter and re-parented the decoded object: `Object.keys(input)` omitted the injected fields while `input.isAdmin` read `true`. `__proto__`, `constructor`, and `prototype` are now skipped on every path, including `GET ?input=` and standalone `RPCHandler.handle()`, neither of which reaches core's body-parser scrub.
- `decode()` now enforces an explicit 32-level depth cap, including inside the nested `JSON.parse` of the `Set`/`Map` wire tags.
- **Breaking:** non-GET requests now require `content-type: application/json`. `multipart/form-data`, `application/x-www-form-urlencoded`, and `text/plain` are CORS-*simple*, so a cross-origin `<form>` could post to any mutation with the victim's cookies and no preflight. Procedures that genuinely need form bodies opt in with `procedure.allowFormData()`.
- **Breaking:** state-changing requests are rejected when `Origin` is cross-origin, or when `Sec-Fetch-Site` is `cross-site`/`same-site`. Configure with `allowedOrigins`, or disable with `originCheck: false`. Clients sending neither header (curl, server-to-server) are unaffected.
- **Breaking:** `/_rpc/openapi.json` and `/_rpc/manifest.json` are no longer served in production by default. Control with `introspection: boolean | "development"`, and guard them with `introspectionMiddlewares` (per-procedure middleware never applied to these endpoints).
- `RPCHandler` accepts a `logger`, so 5xx detail flows through the app logger instead of raw `console.error`.

**@celsian/schema**

- **Breaking:** the TypeBox adapter now strips properties the schema does not declare, matching Zod and Valibot. Previously the same logical schema passed unknown keys through only under TypeBox, so swapping libraries silently changed whether `db.user.update({ data: validated })` was a mass-assignment hole. Opt out with `fromTypeBox(schema, { stripUnknown: false })` or `fromSchema(schema, { typebox: { stripUnknown: false } })`.
- `InferOutput` now understands TypeBox's `static` carrier. TypeBox is what `create-celsian` scaffolds by default, and every TypeBox-typed route and procedure previously inferred `unknown`.
- The "unsupported schema" error now reports what it actually received instead of a generic sentence.
