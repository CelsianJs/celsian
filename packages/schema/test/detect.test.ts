import { describe, expect, it } from "vitest";
import { fromSchema } from "../src/detect.js";

describe("fromSchema (auto-detect)", () => {
  it("should detect a StandardSchema-compatible schema", () => {
    const custom = {
      validate(input: unknown) {
        return { success: true, data: input };
      },
      toJsonSchema() {
        return { type: "object" };
      },
    };

    const schema = fromSchema(custom);
    const result = schema.validate({ foo: "bar" });
    expect(result.success).toBe(true);
  });

  it("should detect Zod-like schemas (safeParse + parse)", () => {
    const zodLike = {
      safeParse(input: unknown) {
        return { success: true, data: input };
      },
      parse(input: unknown) {
        return input;
      },
    };

    const schema = fromSchema(zodLike);
    const result = schema.validate("test");
    expect(result.success).toBe(true);
    expect(result.data).toBe("test");
  });

  it("should detect TypeBox-like schemas (type + properties)", () => {
    const typeboxLike = {
      type: "object",
      properties: { name: { type: "string" } },
    };

    const schema = fromSchema(typeboxLike);
    expect(schema).toBeDefined();
    expect(schema.toJsonSchema()).toEqual(typeboxLike);
  });

  it("should detect Valibot-like schemas (_parse)", () => {
    const valibotLike = {
      _parse(input: unknown) {
        return { success: true, output: input };
      },
    };

    const schema = fromSchema(valibotLike);
    const result = schema.validate("test");
    expect(result.success).toBe(true);
  });

  it("should throw for unsupported schema types", () => {
    expect(() => fromSchema(42)).toThrow("Unsupported schema library");
    expect(() => fromSchema(null)).toThrow("Unsupported schema library");
    expect(() => fromSchema({})).toThrow("Unsupported schema library");
  });
});

describe("fromSchema (modern / hardened detection)", () => {
  // Regression for: Valibot was detected only via the removed `_parse` method, and TypeBox
  // detection (`type !== undefined && properties !== undefined`) was over-broad.
  it("should detect a modern Valibot schema via the `~standard` property", () => {
    // Modern Valibot exposes the StandardSchema `~standard` interface and `~run`,
    // but NOT `safeParse`/`parse` or the legacy `_parse`.
    const modernValibot = {
      "~standard": {
        version: 1,
        vendor: "valibot",
        validate: (value: unknown) => ({ value }),
      },
      "~run": (dataset: { value: unknown }) => ({ typed: true, value: dataset.value }),
    };

    const schema = fromSchema(modernValibot);
    expect(schema).toBeDefined();
    // Routed through the Valibot adapter (falls back to safeParse/_parse internally).
    expect(typeof schema.validate).toBe("function");
  });

  it("should NOT misdetect a plain object {type:'x', properties:{}} as TypeBox", () => {
    const notASchema = { type: "x", properties: {} };
    expect(() => fromSchema(notASchema)).toThrow("Unsupported schema library");
  });

  it("should detect a TypeBox schema via the TypeBox Kind symbol", () => {
    const typeboxKind = Symbol.for("TypeBox.Kind");
    const typeboxSchema = {
      [typeboxKind]: "Object",
      type: "object",
      properties: { name: { type: "string" } },
    };

    const schema = fromSchema(typeboxSchema);
    expect(schema).toBeDefined();
    expect(schema.toJsonSchema()).toEqual(typeboxSchema);
  });
});

describe("fromSchema (real schema libraries)", () => {
  // Regression coverage for PR #48: the suite previously only ever exercised
  // hand-rolled "-like" fakes here, which is exactly how fromValibot() being
  // silently broken for all modern valibot (>=0.31) went undetected. These
  // tests route real, unmodified schema objects from the real npm packages
  // (devDependencies, not mocks) through the public auto-detect entry point.
  it("should detect and validate a real zod schema", async () => {
    const { z } = await import("zod");
    const schema = fromSchema(z.object({ name: z.string() }));

    expect(schema.validate({ name: "Alice" })).toEqual({ success: true, data: { name: "Alice" } });
    const invalid = schema.validate({ name: 5 });
    expect(invalid.success).toBe(false);
    expect(invalid.issues?.[0]?.path).toEqual(["name"]);
  });

  it("should detect and validate a real TypeBox schema", async () => {
    const { Type } = await import("@sinclair/typebox");
    const schema = fromSchema(Type.Object({ name: Type.String() }));

    expect(schema.validate({ name: "Alice" })).toEqual({ success: true, data: { name: "Alice" } });
    const invalid = schema.validate({ name: 5 });
    expect(invalid.success).toBe(false);
    expect(invalid.issues?.length).toBeGreaterThan(0);
  });

  it("should detect and validate a real (modern, Standard-Schema-only) valibot schema", async () => {
    const v = await import("valibot");
    const schema = fromSchema(v.object({ name: v.string() }));

    expect(schema.validate({ name: "Alice" })).toEqual({ success: true, data: { name: "Alice" } });
    const invalid = schema.validate({ name: 5 });
    expect(invalid.success).toBe(false);
    expect(invalid.issues?.length).toBeGreaterThan(0);
  });
});
