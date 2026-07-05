// @celsian/schema — Valibot adapter

import type { SchemaResult, StandardSchema } from "../standard.js";

export function fromValibot<T>(valibotSchema: any): StandardSchema<T, T> {
  return {
    validate(input: unknown): SchemaResult<T> {
      // Modern valibot (>=0.31, including the 1.x series) schemas expose NEITHER
      // `_parse` NOR `safeParse` as methods on the schema — they only implement the
      // Standard Schema spec via `~standard.validate()`. detect.ts routes schemas here
      // specifically because `~standard` is present, so it must be tried first; the
      // `_parse`/`safeParse` branch below only exists for legacy/custom valibot-like
      // objects that predate the Standard Schema contract.
      const standard = valibotSchema?.["~standard"];
      if (standard && typeof standard.validate === "function") {
        const result = standard.validate(input);
        if (result instanceof Promise) {
          // Async valibot schemas (e.g. async `check`/`checkAsync` pipe actions)
          // can't be resolved through this synchronous interface — fail loud
          // instead of returning a bogus result or leaving a dangling Promise.
          return {
            success: false,
            issues: [{ message: "Async Valibot schemas are not supported by validate() — use a synchronous schema." }],
          };
        }
        if (result.issues) {
          return {
            success: false,
            issues: result.issues.map((i: any) => ({
              message: i.message,
              path: i.path?.map((p: any) => (typeof p === "object" && p !== null ? p.key : p)),
            })),
          };
        }
        return { success: true, data: result.value };
      }

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
