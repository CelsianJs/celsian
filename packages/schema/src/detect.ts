// @celsian/schema — Auto-detect schema library by duck-typing

import { fromTypeBox } from "./adapters/typebox.js";
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

export function fromSchema<T>(schema: unknown): StandardSchema<T, T> {
  if (!isRecord(schema)) {
    throw new SchemaError(
      "Unsupported schema library. Use Zod, TypeBox, Valibot, or a StandardSchema-compatible schema.",
    );
  }

  // Already a StandardSchema (our own adapter output / hand-rolled).
  // Checked before `~standard` so explicit adapters round-trip unchanged.
  if (hasMethod(schema, "validate") && hasMethod(schema, "toJsonSchema")) {
    return schema as unknown as StandardSchema<T, T>;
  }

  // TypeBox: identified precisely by the TypeBox Kind symbol stamped on every TypeBox schema.
  // Checked before the JSON-Schema back-compat heuristic so it can't be mis-routed.
  if (TYPEBOX_KIND in schema) {
    return fromTypeBox<T>(schema);
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
    return fromTypeBox<T>(schema);
  }

  throw new SchemaError(
    "Unsupported schema library. Use Zod, TypeBox, Valibot, or a StandardSchema-compatible schema.",
  );
}
