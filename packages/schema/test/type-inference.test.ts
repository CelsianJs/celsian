// @celsian/schema -- compile-time coverage for InferOutput against the REAL
// schema packages.
//
// These assertions are enforced by `tsc`, not by vitest's runtime: the
// `Expect<Equals<...>>` aliases fail to compile when a branch of InferOutput
// stops resolving. Verify with:
//
//   npx tsc --noEmit --ignoreConfig --strict --module esnext \
//     --moduleResolution bundler --target es2022 --skipLibCheck \
//     packages/schema/test/type-inference.test.ts
//
// The runtime `it()` blocks below mirror each assertion so the file also shows
// up in `pnpm test` and fails loudly if the schemas themselves change shape.

import { Type } from "@sinclair/typebox";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fromSchema } from "../src/detect.js";
import type { InferOutput, StandardSchema } from "../src/standard.js";

/** Invariant type equality (distinguishes `unknown` from a concrete type). */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const zodSchema = z.object({ name: z.string() });
const typeboxSchema = Type.Object({ name: Type.String() });
const valibotSchema = v.object({ name: v.string() });

// Zod v3 carries `_output`; zod v4 also satisfies StandardSchema-style inference.
export type ZodInfers = Expect<Equals<InferOutput<typeof zodSchema>, { name: string }>>;

// TASK-5.5: TypeBox 0.30+ exposes its inferred type as `static`, and is NOT
// StandardSchema-shaped. Without a `static` branch this resolved to `unknown`,
// which mattered because TypeBox is what `create-celsian` scaffolds by default.
export type TypeBoxInfers = Expect<Equals<InferOutput<typeof typeboxSchema>, { name: string }>>;

// Celsian's own adapter output.
export type StandardInfers = Expect<Equals<InferOutput<StandardSchema<string, number>>, number>>;

// Unrecognized shapes must still fall back to `unknown` (no accidental widening).
export type FallbackIsUnknown = Expect<Equals<InferOutput<{ validate: () => void }>, unknown>>;

describe("InferOutput carriers (runtime shape mirror)", () => {
  it("TypeBox schemas expose `static` as the inference carrier", () => {
    // `static` is a phantom property: present in the type, absent at runtime.
    // Guard the structural assumptions the type-level branch relies on.
    expect(Symbol.for("TypeBox.Kind") in typeboxSchema).toBe(true);
    expect("_output" in typeboxSchema).toBe(false);
    expect("_type" in typeboxSchema).toBe(false);
  });

  it("all three libraries validate the same object through fromSchema", () => {
    for (const schema of [zodSchema, typeboxSchema, valibotSchema]) {
      const result = fromSchema<{ name: string }>(schema).validate({ name: "Ada" });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: "Ada" });
    }
  });
});
