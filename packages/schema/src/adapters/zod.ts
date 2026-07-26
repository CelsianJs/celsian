// @celsian/schema, Zod adapter

import type { SchemaResult, StandardSchema } from "../standard.js";

/**
 * Minimal structural view of a Zod issue (avoids depending on the zod package).
 *
 * `path` is `PropertyKey[]` because that is what Zod 4 actually produces: its
 * `$ZodIssue.path` allows symbol segments for record keys. Declaring it as
 * `(string | number)[]` made every real `z.object()` schema fail to satisfy
 * this interface. Symbols are normalized to strings on the way out, so the
 * published `SchemaIssue.path` contract is unchanged.
 */
interface ZodIssue {
  message: string;
  path?: readonly PropertyKey[];
}

/**
 * Minimal structural view of the parts of a Zod schema this adapter uses.
 *
 * The result is deliberately NOT a discriminated union on `success`. A union
 * requires the literal types `true`/`false`, which no ordinary object returned
 * from a user function ever has (TypeScript widens `success` to `boolean`), so
 * only Zod's own types could satisfy it. This shape describes exactly the three
 * things the adapter reads, and the adapter narrows at runtime instead.
 */
interface ZodResultLike {
  success: boolean;
  data?: unknown;
  error?: { issues: readonly ZodIssue[] };
}

interface ZodLike {
  safeParse(input: unknown): ZodResultLike;
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
      let result: ZodResultLike;
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
      if (!result.error) {
        // A failed parse with no error object is not something Zod produces.
        // Report it rather than crashing on a missing property or returning an
        // empty (and therefore silent) issue list.
        return {
          success: false,
          issues: [{ message: "Zod schema reported a failed parse without an error object." }],
        };
      }
      return {
        success: false,
        issues: result.error.issues.map((i: ZodIssue) => ({
          message: i.message,
          // Symbol path segments cannot survive JSON serialization, so they are
          // rendered as their description rather than dropped.
          path: i.path?.map((segment) => (typeof segment === "symbol" ? segment.toString() : segment)),
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
