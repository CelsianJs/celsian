// @celsian/schema — TypeBox adapter (first-class)
// Uses top-level await to load TypeBox dynamically (ESM-safe, no require())

import { SchemaError } from "../errors.js";
import type { SchemaResult, StandardSchema } from "../standard.js";

// Pre-load TypeBox Value module at import time via top-level await.
// If @sinclair/typebox is not installed, Value stays null and
// validate() throws a descriptive error on first use.
let Value: any = null;
try {
  const mod = await import("@sinclair/typebox/value");
  Value = mod.Value;
} catch {
  // @sinclair/typebox not installed — will error at validate time
}

/** Options for {@link fromTypeBox}. */
export interface TypeBoxAdapterOptions {
  /**
   * Strip properties the schema does not declare. Defaults to `true`.
   *
   * TypeBox's own default is to let unknown keys through, while Zod and Valibot
   * strip them. Because Celsian presents all three as interchangeable behind
   * `fromSchema()`, that divergence made a library swap silently change whether
   * `db.user.update({ data: validated })` was a mass-assignment hole. Celsian
   * therefore normalizes on the stripping behavior.
   *
   * Set to `false` to keep raw TypeBox semantics (unknown keys pass through).
   */
  stripUnknown?: boolean;
}

export function fromTypeBox<T>(typeboxSchema: any, options?: TypeBoxAdapterOptions): StandardSchema<T, T> {
  const stripUnknown = options?.stripUnknown ?? true;

  return {
    validate(input: unknown): SchemaResult<T> {
      if (!Value) {
        throw new SchemaError(
          "@sinclair/typebox is required for TypeBox schema validation. Install it with: npm install @sinclair/typebox",
        );
      }
      try {
        const errors = [...Value.Errors(typeboxSchema, input)];
        if (errors.length === 0) {
          // Cast is only ever reached once Errors() is empty, so it upcasts a
          // value already known to conform — it never rescues invalid input.
          const cast = Value.Cast(typeboxSchema, input);
          if (!stripUnknown) {
            return { success: true, data: cast };
          }
          // Cast returns the SAME reference when the input already conforms and
          // Clean mutates in place, so clone first: validation must never
          // mutate the caller's request body.
          return { success: true, data: Value.Clean(typeboxSchema, Value.Clone(cast)) };
        }
        return {
          success: false,
          issues: errors.map((e: any) => ({
            message: e.message,
            path: e.path?.split("/").filter(Boolean),
          })),
        };
      } catch (e: any) {
        return { success: false, issues: [{ message: e.message }] };
      }
    },
    toJsonSchema(): Record<string, unknown> {
      // TypeBox schemas ARE JSON Schema
      return typeboxSchema;
    },
    _input: undefined as unknown as T,
    _output: undefined as unknown as T,
  };
}
