import { Type } from "@sinclair/typebox";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { openapi } from "../src/plugins/openapi.js";

/**
 * OpenAPI generation across all three schema libraries Celsian adapts.
 *
 * Every one of these assertions failed before the schema adapters learned to
 * convert their libraries' internals to JSON Schema:
 *
 * - Zod bodies were published as a bare `{ type: "object" }` with no properties.
 * - Valibot bodies were published as Valibot's raw internal AST
 *   (`kind` / `expects` / `entries` / `~standard`), which is not JSON Schema.
 * - A bare (non-status-keyed) `schema.response` enumerated the schema
 *   INSTANCE'S OWN METHOD NAMES as HTTP status codes: `spa`, `_def`, `parse`,
 *   `safeParse`, `refine`, ~29 of them per route.
 * - `schema.querystring` produced no `parameters` at all, because the empty
 *   `{ type: "object" }` had no `properties` to walk.
 */

type MediaType = { schema: JsonSchema };
type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  format?: string;
  minLength?: number;
  enum?: unknown[];
};
type Parameter = { name: string; in: string; required?: boolean; schema?: JsonSchema };
type Operation = {
  parameters?: Parameter[];
  requestBody?: { content: Record<string, MediaType> };
  responses: Record<string, { description: string; content?: Record<string, MediaType> }>;
};
type Spec = { openapi: string; paths: Record<string, Record<string, Operation>> };

async function specFor(register: (app: ReturnType<typeof createApp>) => void): Promise<Spec> {
  const app = createApp();
  await app.register(openapi());
  register(app);
  const res = await app.inject({ method: "GET", url: "/docs/openapi.json" });
  expect(res.status).toBe(200);
  return (await res.json()) as Spec;
}

function operation(spec: Spec, path: string, method = "post"): Operation {
  const op = spec.paths[path]?.[method];
  if (!op) throw new Error(`no ${method} ${path} in spec: ${JSON.stringify(Object.keys(spec.paths))}`);
  return op;
}

function bodySchema(op: Operation): JsonSchema {
  const schema = op.requestBody?.content["application/json"]?.schema;
  if (!schema) throw new Error(`no request body schema: ${JSON.stringify(op)}`);
  return schema;
}

function responseSchema(op: Operation, code: string): JsonSchema {
  const schema = op.responses[code]?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`no ${code} response schema: ${JSON.stringify(op.responses)}`);
  return schema;
}

/** The body schema each library declares, so one set of assertions covers all three. */
const bodySchemas = {
  zod: z.object({
    name: z.string().min(2),
    tags: z.array(z.string()),
    nickname: z.string().optional(),
  }),
  typebox: Type.Object({
    name: Type.String({ minLength: 2 }),
    tags: Type.Array(Type.String()),
    nickname: Type.Optional(Type.String()),
  }),
  valibot: v.object({
    name: v.pipe(v.string(), v.minLength(2)),
    tags: v.array(v.string()),
    nickname: v.optional(v.string()),
  }),
} as const;

const querystringSchemas = {
  zod: z.object({ search: z.string(), page: z.number().optional() }),
  typebox: Type.Object({ search: Type.String(), page: Type.Optional(Type.Number()) }),
  valibot: v.object({ search: v.string(), page: v.optional(v.number()) }),
} as const;

const responseSchemas = {
  zod: z.object({ ok: z.boolean() }),
  typebox: Type.Object({ ok: Type.Boolean() }),
  valibot: v.object({ ok: v.boolean() }),
} as const;

const libraries = ["zod", "typebox", "valibot"] as const;

describe.each(libraries)("OpenAPI generation with %s schemas", (library) => {
  it("publishes real JSON Schema for schema.body", async () => {
    const spec = await specFor((app) => {
      app.post("/items", { schema: { body: bodySchemas[library] } }, () => ({ ok: true }));
    });

    const schema = bodySchema(operation(spec, "/items"));
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["name", "nickname", "tags"]);
    expect(schema.properties?.name?.type).toBe("string");
    expect(schema.properties?.name?.minLength).toBe(2);
    expect(schema.properties?.tags?.type).toBe("array");
    expect(schema.properties?.tags?.items?.type).toBe("string");
    expect(schema.properties?.nickname?.type).toBe("string");
    expect(schema.required?.slice().sort()).toEqual(["name", "tags"]);

    // No schema-library internals may leak into the document.
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain("~standard");
    expect(serialized).not.toContain('"kind"');
    expect(serialized).not.toContain('"expects"');
  });

  it("publishes schema.querystring as query parameters", async () => {
    const spec = await specFor((app) => {
      app.post("/search", { schema: { querystring: querystringSchemas[library] } }, () => ({ ok: true }));
    });

    const parameters = operation(spec, "/search").parameters ?? [];
    const byName = new Map(parameters.map((p) => [p.name, p]));
    expect([...byName.keys()].sort()).toEqual(["page", "search"]);

    expect(byName.get("search")?.in).toBe("query");
    expect(byName.get("search")?.required).toBe(true);
    expect(byName.get("search")?.schema?.type).toBe("string");

    expect(byName.get("page")?.required).toBe(false);
    expect(byName.get("page")?.schema?.type).toBe("number");
  });

  it("publishes a bare schema.response as a single 200 response", async () => {
    const spec = await specFor((app) => {
      app.post("/bare", { schema: { response: responseSchemas[library] } }, () => ({ ok: true }));
    });

    const op = operation(spec, "/bare");
    // The whole defect in one assertion: this used to be ~29 keys named after
    // the schema instance's methods.
    expect(Object.keys(op.responses)).toEqual(["200"]);

    const schema = responseSchema(op, "200");
    expect(schema.type).toBe("object");
    expect(schema.properties?.ok?.type).toBe("boolean");
    expect(schema.required).toEqual(["ok"]);
  });

  it("publishes a status-keyed schema.response under its status codes", async () => {
    const spec = await specFor((app) => {
      app.post(
        "/keyed",
        { schema: { response: { 200: responseSchemas[library], 404: bodySchemas[library] } } },
        () => ({ ok: true }),
      );
    });

    const op = operation(spec, "/keyed");
    expect(Object.keys(op.responses).sort()).toEqual(["200", "404"]);
    expect(responseSchema(op, "200").properties?.ok?.type).toBe("boolean");
    expect(responseSchema(op, "404").properties?.name?.type).toBe("string");
  });

  it("emits only numeric status codes across a whole document", async () => {
    const spec = await specFor((app) => {
      app.post(
        "/everything",
        {
          schema: {
            body: bodySchemas[library],
            querystring: querystringSchemas[library],
            response: responseSchemas[library],
          },
        },
        () => ({ ok: true }),
      );
      app.get("/plain", () => ({ ok: true }));
    });

    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods)) {
        for (const code of Object.keys(op.responses)) {
          expect(code, `status code "${code}" is not a valid OpenAPI response key`).toMatch(/^([1-5]\d\d|default)$/);
        }
      }
    }
  });
});

describe("OpenAPI schema extraction edge cases", () => {
  it("still passes plain JSON Schema fragments through untouched", async () => {
    const spec = await specFor((app) => {
      app.post(
        "/plain-json-schema",
        {
          schema: {
            body: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
          },
        },
        () => ({ ok: true }),
      );
    });

    const schema = bodySchema(operation(spec, "/plain-json-schema"));
    expect(schema.properties?.id?.type).toBe("integer");
    expect(schema.required).toEqual(["id"]);
  });

  it("documents Zod string formats and enums", async () => {
    const spec = await specFor((app) => {
      app.post(
        "/typed",
        {
          schema: {
            body: z.object({
              email: z.string().email(),
              role: z.enum(["admin", "user"]),
              count: z.number().int().min(1),
            }),
          },
        },
        () => ({ ok: true }),
      );
    });

    const schema = bodySchema(operation(spec, "/typed"));
    expect(schema.properties?.email?.format).toBe("email");
    expect(schema.properties?.role?.enum).toEqual(["admin", "user"]);
    expect(schema.properties?.count?.type).toBe("integer");
  });

  it("documents Valibot string formats and picklists", async () => {
    const spec = await specFor((app) => {
      app.post(
        "/typed-valibot",
        {
          schema: {
            body: v.object({
              email: v.pipe(v.string(), v.email()),
              role: v.picklist(["admin", "user"]),
              count: v.pipe(v.number(), v.integer(), v.minValue(1)),
            }),
          },
        },
        () => ({ ok: true }),
      );
    });

    const schema = bodySchema(operation(spec, "/typed-valibot"));
    expect(schema.properties?.email?.format).toBe("email");
    expect(schema.properties?.role?.enum).toEqual(["admin", "user"]);
    expect(schema.properties?.count?.type).toBe("integer");
  });

  it("falls back to a generic 200 when a route declares no response schema", async () => {
    const spec = await specFor((app) => {
      app.get("/no-schema", () => ({ ok: true }));
    });

    expect(operation(spec, "/no-schema", "get").responses).toEqual({
      "200": { description: "Successful response" },
    });
  });
});
