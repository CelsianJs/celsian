// @celsian/schema — Zod adapter

import type { SchemaResult, StandardSchema } from "../standard.js";

/** Minimal structural view of a Zod issue (avoids depending on the zod package). */
interface ZodIssue {
  message: string;
  path?: (string | number)[];
}

/** Minimal structural view of the parts of a Zod schema this adapter uses. */
interface ZodLike {
  safeParse(input: unknown): { success: true; data: unknown } | { success: false; error: { issues: ZodIssue[] } };
  toJsonSchema?(): Record<string, unknown>;
}

export function fromZod<T>(zodSchema: ZodLike): StandardSchema<T, T> {
  return {
    validate(input: unknown): SchemaResult<T> {
      const result = zodSchema.safeParse(input);
      if (result.success) {
        return { success: true, data: result.data as T };
      }
      return {
        success: false,
        issues: result.error.issues.map((i: ZodIssue) => ({
          message: i.message,
          path: i.path,
        })),
      };
    },
    toJsonSchema(): Record<string, unknown> {
      if (typeof zodSchema.toJsonSchema === "function") {
        return zodSchema.toJsonSchema();
      }
      return { type: "object" };
    },
    _input: undefined as unknown as T,
    _output: undefined as unknown as T,
  };
}
