import { Type } from "@sinclair/typebox";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { procedure } from "../src/procedure.js";
import { RPCHandler, router } from "../src/router.js";

/**
 * `RPCHandler.generateOpenAPI()` reads each procedure's schema through the same
 * `@celsian/schema` adapters the REST plugin uses, so it inherited the same
 * defect: every Zod-typed procedure documented its input and output as a bare
 * `{ type: "object" }` with no properties, and Valibot leaked its internal AST.
 */

type JsonSchema = { type?: string; properties?: Record<string, { type?: string }>; required?: string[] };
type Operation = {
  parameters?: Array<{ name: string; in: string; content?: Record<string, { schema: JsonSchema }> }>;
  requestBody?: { content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }>;
};

const inputs = {
  zod: z.object({ name: z.string(), age: z.number().optional() }),
  typebox: Type.Object({ name: Type.String(), age: Type.Optional(Type.Number()) }),
  valibot: v.object({ name: v.string(), age: v.optional(v.number()) }),
} as const;

const outputs = {
  zod: z.object({ id: z.string() }),
  typebox: Type.Object({ id: Type.String() }),
  valibot: v.object({ id: v.string() }),
} as const;

describe.each(["zod", "typebox", "valibot"] as const)("RPC OpenAPI with %s schemas", (library) => {
  it("documents a mutation's input body and output shape", () => {
    const handler = new RPCHandler(
      router({
        create: procedure
          .input(inputs[library])
          .output(outputs[library])
          .mutation(() => ({ id: "1" })),
      }),
    );

    const spec = handler.generateOpenAPI();
    const op = spec.paths["/_rpc/create"]?.post as unknown as Operation;

    const body = op.requestBody?.content["application/json"]?.schema;
    expect(body?.type).toBe("object");
    expect(Object.keys(body?.properties ?? {}).sort()).toEqual(["age", "name"]);
    expect(body?.properties?.name?.type).toBe("string");
    expect(body?.required).toEqual(["name"]);

    const output = op.responses["200"]?.content?.["application/json"]?.schema;
    expect(output?.properties?.id?.type).toBe("string");

    expect(JSON.stringify(op)).not.toContain("~standard");
  });

  it("documents a query's input as a JSON-encoded query parameter", () => {
    const handler = new RPCHandler(
      router({
        find: procedure.input(inputs[library]).query(() => ({ id: "1" })),
      }),
    );

    const spec = handler.generateOpenAPI();
    const op = spec.paths["/_rpc/find"]?.get as unknown as Operation;

    const parameter = op.parameters?.[0];
    expect(parameter?.name).toBe("input");
    expect(parameter?.in).toBe("query");
    // A parameter declares `schema` OR `content`, never both. This used to be
    // `schema: { type: "string" }`, which described nothing about the input.
    expect(parameter && "schema" in parameter).toBe(false);

    const schema = parameter?.content?.["application/json"]?.schema;
    expect(schema?.properties?.name?.type).toBe("string");
    expect(schema?.required).toEqual(["name"]);
  });
});
