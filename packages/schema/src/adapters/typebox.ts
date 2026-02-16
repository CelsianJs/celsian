// @celsian/schema — TypeBox adapter (first-class)

import { createRequire } from 'node:module';
import type { StandardSchema, SchemaResult } from '../standard.js';

const require = createRequire(import.meta.url);

export function fromTypeBox<T>(typeboxSchema: any): StandardSchema<T, T> {
  // Lazy-load Value from @sinclair/typebox/value
  let Value: any;

  function getValueModule(): any {
    if (!Value) {
      try {
        Value = require('@sinclair/typebox/value').Value;
      } catch {
        throw new Error('@sinclair/typebox is required for TypeBox schema validation. Install it with: npm install @sinclair/typebox');
      }
    }
    return Value;
  }

  return {
    validate(input: unknown): SchemaResult<T> {
      try {
        const V = getValueModule();
        const errors = [...V.Errors(typeboxSchema, input)];
        if (errors.length === 0) {
          return { success: true, data: V.Cast(typeboxSchema, input) };
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
