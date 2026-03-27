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
