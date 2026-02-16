// @celsian/schema — Zod adapter

import type { StandardSchema, SchemaResult } from '../standard.js';

export function fromZod<T>(zodSchema: any): StandardSchema<T, T> {
  return {
    validate(input: unknown): SchemaResult<T> {
      const result = zodSchema.safeParse(input);
      if (result.success) {
        return { success: true, data: result.data };
      }
      return {
        success: false,
        issues: result.error.issues.map((i: any) => ({
          message: i.message,
          path: i.path,
        })),
      };
    },
    toJsonSchema(): Record<string, unknown> {
      if (typeof zodSchema.toJsonSchema === 'function') {
        return zodSchema.toJsonSchema();
      }
      return { type: 'object' };
    },
    _input: undefined as unknown as T,
    _output: undefined as unknown as T,
  };
}
