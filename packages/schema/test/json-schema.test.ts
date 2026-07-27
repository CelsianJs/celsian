import { Type } from "@sinclair/typebox";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { type ZodType, z as zod4 } from "zod";
// Zod 3 and Zod 4 have COMPLETELY different internals (`_def.typeName` vs
// `_zod.def.type`), and the docs, the examples, and the repo root all still run
// Zod 3, so both have to be covered by real packages rather than fixtures.
// `zod` resolves to 4.x inside this package; the repo root's devDependency is
// the 3.x build, reached here by explicit path because there is no other way to
// hold two majors of one package in a single test file.
import { z as zod3 } from "../../../node_modules/zod/index.js";
import { fromSchema } from "../src/detect.js";
import { valibotToJsonSchema, zodToJsonSchema } from "../src/json-schema.js";

describe("zodToJsonSchema", () => {
  // Guard the import above: if the root ever moves to Zod 4, these tests would
  // silently stop covering the Zod 3 code path.
  it("has a real Zod 3 build available", () => {
    expect(zod3.string()._def.typeName).toBe("ZodString");
    expect(zod4.string()._zod.def.type).toBe("string");
  });

  describe.each([
    ["zod 3", zod3 as unknown as typeof zod4],
    ["zod 4", zod4],
  ])("%s", (_label, z) => {
    it("converts an object schema with required and optional members", () => {
      const json = zodToJsonSchema(
        z.object({
          name: z.string(),
          age: z.number().optional(),
          nickname: z.string().default("anon"),
        }),
      );

      expect(json).toMatchObject({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          nickname: { type: "string", default: "anon" },
        },
        required: ["name"],
      });
    });

    it("converts string constraints and formats", () => {
      const json = zodToJsonSchema(
        z.object({
          email: z.string().email(),
          url: z.string().url(),
          uuid: z.string().uuid(),
          bounded: z.string().min(2).max(8),
          pattern: z.string().regex(/^ab+$/),
        }),
      );
      const properties = json.properties as Record<string, Record<string, unknown>>;

      expect(properties.email).toMatchObject({ type: "string", format: "email" });
      expect(properties.url).toMatchObject({ type: "string", format: "uri" });
      expect(properties.uuid).toMatchObject({ type: "string", format: "uuid" });
      expect(properties.bounded).toMatchObject({ type: "string", minLength: 2, maxLength: 8 });
      expect(properties.pattern).toMatchObject({ type: "string", pattern: "^ab+$" });
    });

    it("converts number constraints", () => {
      const json = zodToJsonSchema(
        z.object({
          score: z.number().min(0).max(100),
          count: z.number().int(),
          step: z.number().multipleOf(5),
        }),
      );
      const properties = json.properties as Record<string, Record<string, unknown>>;

      expect(properties.score).toMatchObject({ type: "number", minimum: 0, maximum: 100 });
      expect(properties.count).toEqual({ type: "integer" });
      expect(properties.step).toMatchObject({ type: "number", multipleOf: 5 });
    });

    it("converts arrays, records, tuples and sets", () => {
      const json = zodToJsonSchema(
        z.object({
          tags: z.array(z.string()).min(1),
          lookup: z.record(z.string(), z.number()),
          pair: z.tuple([z.string(), z.number()]),
          unique: z.set(z.string()),
        }),
      );
      const properties = json.properties as Record<string, Record<string, unknown>>;

      expect(properties.tags).toMatchObject({ type: "array", items: { type: "string" }, minItems: 1 });
      expect(properties.lookup).toEqual({ type: "object", additionalProperties: { type: "number" } });
      expect(properties.pair).toMatchObject({
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
      });
      expect(properties.unique).toMatchObject({ type: "array", items: { type: "string" }, uniqueItems: true });
    });

    it("converts enums, literals, unions and nullables", () => {
      const json = zodToJsonSchema(
        z.object({
          role: z.enum(["admin", "user"]),
          kind: z.literal("fixed"),
          either: z.union([z.string(), z.number()]),
          maybe: z.string().nullable(),
        }),
      );
      const properties = json.properties as Record<string, Record<string, unknown>>;

      expect(properties.role).toEqual({ type: "string", enum: ["admin", "user"] });
      expect(properties.kind).toEqual({ type: "string", const: "fixed" });
      expect(properties.either).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
      expect(properties.maybe).toEqual({ type: ["string", "null"] });
    });

    it("converts dates and booleans", () => {
      const json = zodToJsonSchema(z.object({ when: z.date(), yes: z.boolean() }));
      const properties = json.properties as Record<string, Record<string, unknown>>;

      expect(properties.when).toEqual({ type: "string", format: "date-time" });
      expect(properties.yes).toEqual({ type: "boolean" });
    });

    it("looks through transforms to the input shape", () => {
      const json = zodToJsonSchema(z.object({ raw: z.string().transform((s: string) => s.length) }));
      expect((json.properties as Record<string, unknown>).raw).toMatchObject({ type: "string" });
    });

    it("carries descriptions through", () => {
      const json = zodToJsonSchema(z.object({ name: z.string().describe("the name") }));
      expect((json.properties as Record<string, Record<string, unknown>>).name.description).toBe("the name");
    });

    it("nests objects", () => {
      const json = zodToJsonSchema(z.object({ user: z.object({ id: z.string() }) }));
      expect((json.properties as Record<string, unknown>).user).toMatchObject({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      });
    });

    it("terminates on self-referential lazy schemas", () => {
      const node: ZodType = z.lazy(() => z.object({ id: z.string(), child: node.optional() }));
      const json = zodToJsonSchema(node);
      expect(json.type).toBe("object");
      expect((json.properties as Record<string, unknown>).id).toEqual({ type: "string" });
    });

    it("returns an empty schema for values that are not Zod schemas", () => {
      expect(zodToJsonSchema(null)).toEqual({});
      expect(zodToJsonSchema({ nope: true })).toEqual({});
    });
  });

  it("reaches the converter through fromSchema (the path OpenAPI uses)", () => {
    const wrapped = fromSchema(zod4.object({ id: zod4.string() }));
    expect(wrapped.toJsonSchema()).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
  });
});

describe("valibotToJsonSchema", () => {
  it("converts an object schema with required and optional members", () => {
    const json = valibotToJsonSchema(
      v.object({
        name: v.string(),
        age: v.optional(v.number()),
        nickname: v.optional(v.string(), "anon"),
      }),
    );

    expect(json).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        nickname: { type: "string", default: "anon" },
      },
      required: ["name"],
    });
  });

  it("folds pipe actions into the base schema", () => {
    const json = valibotToJsonSchema(
      v.object({
        email: v.pipe(v.string(), v.email(), v.description("work address")),
        bounded: v.pipe(v.string(), v.minLength(2), v.maxLength(8)),
        score: v.pipe(v.number(), v.minValue(0), v.maxValue(100), v.integer()),
        tags: v.pipe(v.array(v.string()), v.minLength(1)),
        pattern: v.pipe(v.string(), v.regex(/^ab+$/)),
      }),
    );
    const properties = json.properties as Record<string, Record<string, unknown>>;

    expect(properties.email).toMatchObject({ type: "string", format: "email", description: "work address" });
    expect(properties.bounded).toMatchObject({ type: "string", minLength: 2, maxLength: 8 });
    expect(properties.score).toMatchObject({ type: "integer", minimum: 0, maximum: 100 });
    expect(properties.tags).toMatchObject({ type: "array", items: { type: "string" }, minItems: 1 });
    expect(properties.pattern).toMatchObject({ type: "string", pattern: "^ab+$" });
  });

  it("converts picklists, enums, literals, unions and nullables", () => {
    const json = valibotToJsonSchema(
      v.object({
        role: v.picklist(["admin", "user"]),
        named: v.enum({ A: "a", B: "b" }),
        kind: v.literal("fixed"),
        either: v.union([v.string(), v.number()]),
        maybe: v.nullable(v.string()),
      }),
    );
    const properties = json.properties as Record<string, Record<string, unknown>>;

    expect(properties.role).toEqual({ type: "string", enum: ["admin", "user"] });
    expect(properties.named).toEqual({ type: "string", enum: ["a", "b"] });
    expect(properties.kind).toEqual({ type: "string", const: "fixed" });
    expect(properties.either).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect(properties.maybe).toEqual({ type: ["string", "null"] });
  });

  it("converts object variants, records and tuples", () => {
    const json = valibotToJsonSchema(
      v.object({
        strict: v.strictObject({ a: v.string() }),
        loose: v.looseObject({ a: v.string() }),
        lookup: v.record(v.string(), v.number()),
        pair: v.tuple([v.string(), v.number()]),
      }),
    );
    const properties = json.properties as Record<string, Record<string, unknown>>;

    expect(properties.strict).toMatchObject({ type: "object", additionalProperties: false });
    expect(properties.loose).toMatchObject({ type: "object", additionalProperties: true });
    expect(properties.lookup).toEqual({ type: "object", additionalProperties: { type: "number" } });
    expect(properties.pair).toMatchObject({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
    });
  });

  it("emits no Valibot internals", () => {
    const serialized = JSON.stringify(valibotToJsonSchema(v.object({ name: v.string() })));
    expect(serialized).not.toContain("~standard");
    expect(serialized).not.toContain("expects");
    expect(serialized).not.toContain("kind");
  });

  it("terminates on self-referential lazy schemas", () => {
    const node: v.GenericSchema = v.lazy(() => v.object({ id: v.string(), child: v.optional(node) }));
    const json = valibotToJsonSchema(node);
    expect(json.type).toBe("object");
    expect((json.properties as Record<string, unknown>).id).toEqual({ type: "string" });
  });

  it("returns an empty schema for values that are not Valibot schemas", () => {
    expect(valibotToJsonSchema(null)).toEqual({});
    expect(valibotToJsonSchema({ nope: true })).toEqual({});
  });

  it("reaches the converter through fromSchema (the path OpenAPI uses)", () => {
    const wrapped = fromSchema(v.object({ id: v.string() }));
    expect(wrapped.toJsonSchema()).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
  });
});

describe("TypeBox schemas are already JSON Schema", () => {
  it("passes through fromSchema unchanged", () => {
    const wrapped = fromSchema(Type.Object({ id: Type.String() }));
    expect(wrapped.toJsonSchema()).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
  });
});
