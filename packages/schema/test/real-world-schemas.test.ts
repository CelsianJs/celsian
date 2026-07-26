// @celsian/schema -- e2e coverage against the real npm packages for every
// supported schema library, exercised through the public `fromSchema()`
// auto-detect entry point (not hand-rolled "-like" fakes).
//
// PR #48 fixed `fromValibot()` being silently broken for all modern valibot
// (>=0.31) because the suite only ever validated against hand-rolled
// valibot-LIKE objects, never the real package. These tests close that class
// of gap for zod, typebox, and valibot: each is imported for real (devDependency,
// not a mock) and driven through `fromSchema`, the same path a Celsian user's
// route schema takes.

import { Type } from "@sinclair/typebox";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fromSchema } from "../src/detect.js";

describe("fromSchema against real schema libraries", () => {
  describe("real zod", () => {
    const schema = z.object({ name: z.string(), age: z.number().int().min(0) });

    it("returns parsed data for a valid input", () => {
      const result = fromSchema<{ name: string; age: number }>(schema).validate({ name: "Alice", age: 30 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: "Alice", age: 30 });
    });

    it("returns per-field issues for invalid input", () => {
      const result = fromSchema(schema).validate({ name: 5, age: -1 });
      expect(result.success).toBe(false);
      expect(result.issues?.length).toBeGreaterThanOrEqual(2);
      const paths = result.issues?.map((i) => i.path?.join("."));
      expect(paths).toContain("name");
      expect(paths).toContain("age");
    });
  });

  describe("real TypeBox", () => {
    const schema = Type.Object({ name: Type.String(), age: Type.Integer({ minimum: 0 }) });

    it("returns parsed data for a valid input", () => {
      const result = fromSchema<{ name: string; age: number }>(schema).validate({ name: "Bob", age: 22 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: "Bob", age: 22 });
    });

    it("returns per-field issues for invalid input", () => {
      const result = fromSchema(schema).validate({ name: 5, age: -1 });
      expect(result.success).toBe(false);
      expect(result.issues?.length).toBeGreaterThanOrEqual(1);
      const paths = result.issues?.map((i) => i.path?.join("."));
      expect(paths?.some((p) => p === "name" || p === "age")).toBe(true);
    });
  });

  describe("real valibot", () => {
    // Modern valibot (>=0.31, incl. the 1.x installed here) exposes neither
    // `_parse` nor `safeParse` -- only the Standard Schema `~standard` contract.
    // This is exactly the shape that PR #48 fixed detection/validation for.
    const schema = v.object({ name: v.string(), age: v.pipe(v.number(), v.integer(), v.minValue(0)) });

    it("returns parsed data for a valid input", () => {
      const result = fromSchema<{ name: string; age: number }>(schema).validate({ name: "Cara", age: 41 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: "Cara", age: 41 });
    });

    it("returns per-field issues for invalid input", () => {
      const result = fromSchema(schema).validate({ name: 5, age: -1 });
      expect(result.success).toBe(false);
      expect(result.issues?.length).toBeGreaterThanOrEqual(1);
      const paths = result.issues?.map((i) => i.path?.join("."));
      expect(paths?.some((p) => p === "name" || p === "age")).toBe(true);
    });
  });
});

// M-10: the same logical schema must behave the same in every library.
// Before the fix, TypeBox let `isAdmin` through while zod and valibot stripped
// it, so swapping libraries silently turned `db.user.update({ data })` into a
// mass-assignment hole.
describe("unknown-key handling parity across libraries (M-10)", () => {
  const dirty = { name: "a", isAdmin: true };

  it("zod strips unknown keys", () => {
    const result = fromSchema(z.object({ name: z.string() })).validate(dirty);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "a" });
  });

  it("valibot strips unknown keys", () => {
    const result = fromSchema(v.object({ name: v.string() })).validate(dirty);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "a" });
  });

  it("TypeBox strips unknown keys too", () => {
    const result = fromSchema(Type.Object({ name: Type.String() })).validate(dirty);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "a" });
    expect(Object.keys(result.data as object)).not.toContain("isAdmin");
  });

  it("TypeBox strips unknown keys in nested objects and arrays", () => {
    const schema = Type.Object({
      user: Type.Object({ name: Type.String() }),
      tags: Type.Array(Type.Object({ id: Type.Number() })),
    });
    const result = fromSchema(schema).validate({
      user: { name: "a", role: "admin" },
      tags: [{ id: 1, secret: "x" }],
      extra: true,
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ user: { name: "a" }, tags: [{ id: 1 }] });
  });

  it("does not mutate the caller's input object while stripping", () => {
    const input = { name: "a", isAdmin: true };
    fromSchema(Type.Object({ name: Type.String() })).validate(input);
    expect(input).toEqual({ name: "a", isAdmin: true });
  });

  it("leaves additionalProperties:false schemas to fail validation as before", () => {
    const strict = Type.Object({ name: Type.String() }, { additionalProperties: false });
    const result = fromSchema(strict).validate(dirty);
    expect(result.success).toBe(false);
    expect(result.issues?.[0]?.path).toEqual(["isAdmin"]);
  });

  it("keeps unknown keys when stripUnknown is explicitly disabled", () => {
    const result = fromSchema(Type.Object({ name: Type.String() }), {
      typebox: { stripUnknown: false },
    }).validate(dirty);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "a", isAdmin: true });
  });
});

// The Valibot adapter already refused async schemas with a clean result. Zod
// threw `$ZodAsyncError` straight out of validate() instead, so the same
// mistake crashed under one library and returned an error under another.
describe("async schemas fail loud, consistently, in every adapter", () => {
  it("valibot returns an issue rather than a dangling promise", () => {
    const schema = v.objectAsync({
      name: v.pipeAsync(
        v.string(),
        v.checkAsync(async () => true),
      ),
    });
    const result = fromSchema(schema).validate({ name: "a" });
    expect(result.success).toBe(false);
    expect(result.issues?.[0]?.message).toMatch(/Async Valibot schemas are not supported/);
  });

  it("zod returns an issue rather than throwing out of validate()", () => {
    const schema = z.object({ name: z.string().refine(async () => true) });
    let result: ReturnType<ReturnType<typeof fromSchema>["validate"]> | undefined;
    expect(() => {
      result = fromSchema(schema).validate({ name: "a" });
    }).not.toThrow();
    expect(result?.success).toBe(false);
    expect(result?.issues?.[0]?.message).toMatch(/Async Zod schemas are not supported/);
  });

  it("still rethrows non-async adapter errors instead of masking them", () => {
    const exploding = {
      safeParse() {
        throw new TypeError("adapter bug");
      },
      parse() {},
    };
    expect(() => fromSchema(exploding).validate({})).toThrow("adapter bug");
  });
});
