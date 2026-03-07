// @celsian/schema — TypeBox adapter (first-class)
// Uses top-level await to load TypeBox dynamically (ESM-safe, no require())

import type { StandardSchema, SchemaResult } from '../standard.js';

// Pre-load TypeBox Value module at import time via top-level await.
// If @sinclair/typebox is not installed, Value stays null and
// validate() throws a descriptive error on first use.
let Value: any = null;
try {
  const mod = await import('@sinclair/typebox/value');
  Value = mod.Value;
} catch {
  // @sinclair/typebox not installed — will error at validate time
}

export function fromTypeBox<T>(typeboxSchema: any): StandardSchema<T, T> {
  return {
    validate(input: unknown): SchemaResult<T> {
      if (!Value) {
        throw new Error(
          '@sinclair/typebox is required for TypeBox schema validation. Install it with: npm install @sinclair/typebox',
        );
      }
      try {
        const errors = [...Value.Errors(typeboxSchema, input)];
        if (errors.length === 0) {
          return { success: true, data: Value.Cast(typeboxSchema, input) };
        }
        return {
          success: false,
          issues: errors.map((e: any) => ({
            message: e.message,
            path: e.path?.split('/').filter(Boolean),
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
