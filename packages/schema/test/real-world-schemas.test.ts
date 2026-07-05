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
