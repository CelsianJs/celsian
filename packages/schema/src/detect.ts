// @celsian/schema, Auto-detect schema library by duck-typing

import { fromTypeBox, type TypeBoxAdapterOptions } from "./adapters/typebox.js";
import { fromValibot } from "./adapters/valibot.js";
import { fromZod } from "./adapters/zod.js";
import { SchemaError } from "./errors.js";
import type { StandardSchema } from "./standard.js";

// The TypeBox Kind symbol is stamped on every TypeBox schema (e.g. Type.Object()).
// Detecting it avoids misclassifying plain JSON-Schema-shaped objects as TypeBox.
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

/** Narrow an unknown value to an indexable record without using `any`. */
function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

/** True if `value[key]` is a callable function. */
function hasMethod(value: Record<PropertyKey, unknown>, key: PropertyKey): boolean {
  return typeof value[key] === "function";
}

/**
 * Describe an unsupported value concretely so the thrown error is actionable:
 * the old message never said what it actually received. Mirrors the style of
 * `@celsian/core`'s `assertPlugin`.
 */
function describeSchema(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `an Array (length ${value.length})`;
  if (typeof value === "function") return `a function (${(value as { name?: string }).name || "anonymous"})`;
  if (typeof value !== "object") return `${typeof value} (${String(value)})`;

  const keys = Object.keys(value as object);
  const preview =
    keys.length > 0 ? `keys: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", …" : ""}` : "no own keys";
  const ctor = (value as object).constructor?.name;
  const label = ctor && ctor !== "Object" ? `a ${ctor} object` : "an object";
  return `${label} with ${preview}`;
}

function unsupportedSchemaError(schema: unknown): SchemaError {
  return new SchemaError(
    `Unsupported schema: received ${describeSchema(schema)}. ` +
      "Expected a Zod schema (has safeParse + parse), a TypeBox schema (built with Type.*), " +
      "a Valibot schema (has ~standard), or an object implementing Celsian's StandardSchema " +
      "(validate + toJsonSchema). If you are passing a plain JSON Schema, it must be an object " +
      'schema of the form { type: "object", properties: { … } }.',
  );
}

export function fromSchema<T>(schema: unknown, options?: { typebox?: TypeBoxAdapterOptions }): StandardSchema<T, T> {
  if (!isRecord(schema)) {
    throw unsupportedSchemaError(schema);
  }

  // Already a StandardSchema (our own adapter output / hand-rolled).
  // Checked before `~standard` so explicit adapters round-trip unchanged.
  if (hasMethod(schema, "validate") && hasMethod(schema, "toJsonSchema")) {
    return schema as unknown as StandardSchema<T, T>;
  }

  // TypeBox: identified precisely by the TypeBox Kind symbol stamped on every TypeBox schema.
  // Checked before the JSON-Schema back-compat heuristic so it can't be mis-routed.
  if (TYPEBOX_KIND in schema) {
    return fromTypeBox<T>(schema, options?.typebox);
  }

  // Zod: has safeParse + parse (covers both legacy and modern Zod 3.24+, which also adds `~standard`).
  if (hasMethod(schema, "safeParse") && hasMethod(schema, "parse")) {
    return fromZod<T>(schema as unknown as Parameters<typeof fromZod<T>>[0]);
  }

  // Valibot: modern StandardSchema spec (`~standard` / `~run`) or legacy (`_parse`).
  // Modern Valibot implements StandardSchema's `~standard` but, unlike Zod, has no `safeParse`/`parse`,
  // so detecting `~standard` here covers Zod-3.24-independent, version-resilient Valibot detection.
  if ("~standard" in schema || hasMethod(schema, "~run") || hasMethod(schema, "_parse")) {
    return fromValibot<T>(schema);
  }

  // Back-compat: legacy TypeBox / plain JSON-Schema OBJECT schemas without a Kind symbol that
  // previous versions accepted. Narrowed from the old over-broad `type!==undefined &&
  // properties!==undefined` to `type === "object" && properties is an object`, so arbitrary records
  // like `{ type: "x", properties: {} }` are no longer misdetected as TypeBox. Kept last so it
  // can't shadow more specific detection.
  if (schema.type === "object" && isRecord(schema.properties)) {
    return fromTypeBox<T>(schema, options?.typebox);
  }

  throw unsupportedSchemaError(schema);
}
