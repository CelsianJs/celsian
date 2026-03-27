// @celsian/schema — Valibot adapter

import type { SchemaResult, StandardSchema } from "../standard.js";

export function fromValibot<T>(valibotSchema: any): StandardSchema<T, T> {
  return {
    validate(input: unknown): SchemaResult<T> {
      try {
        const result = valibotSchema._parse?.(input) ?? valibotSchema.safeParse?.(input);
        if (!result) {
          return { success: false, issues: [{ message: "Unknown valibot schema format" }] };
        }
        if (result.success !== false && !result.issues) {
          return { success: true, data: result.output ?? result.data };
        }
        return {
          success: false,
          issues: (result.issues || []).map((i: any) => ({
            message: i.message,
            path: i.path?.map((p: any) => p.key),
          })),
        };
      } catch (e: any) {
        return { success: false, issues: [{ message: e.message }] };
      }
    },
    toJsonSchema(): Record<string, unknown> {
      return { type: "object" };
    },
    _input: undefined as unknown as T,
    _output: undefined as unknown as T,
  };
}
