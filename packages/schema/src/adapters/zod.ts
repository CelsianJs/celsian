// @celsian/schema, Zod adapter

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

/**
 * True when Zod refused a synchronous parse because the schema contains an
 * async refinement/transform. Zod 4 throws `$ZodAsyncError`; Zod 3 throws a
 * plain Error. Matched narrowly so genuine adapter bugs still surface.
 */
function isZodAsyncError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.constructor?.name === "$ZodAsyncError" ||
    /Promise during synchronous parse|Synchronous parse encountered promise/i.test(error.message)
  );
}

export function fromZod<T>(zodSchema: ZodLike): StandardSchema<T, T> {
  return {
    validate(input: unknown): SchemaResult<T> {
      let result: ReturnType<ZodLike["safeParse"]>;
      try {
        result = zodSchema.safeParse(input);
      } catch (error) {
        // Async Zod schemas can't be resolved through this synchronous
        // interface. Fail loud as a result (mirroring the Valibot adapter)
        // instead of throwing out of validate(), which every caller treats as
        // a crash rather than a validation outcome. Anything else rethrows.
        if (isZodAsyncError(error)) {
          return {
            success: false,
            issues: [{ message: "Async Zod schemas are not supported by validate(), use a synchronous schema." }],
          };
        }
        throw error;
      }
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
