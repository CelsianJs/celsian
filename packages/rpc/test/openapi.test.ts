import { describe, expect, it } from "vitest";
import { generateOpenAPI } from "../src/openapi.js";
import type { ProcedureDefinition } from "../src/types.js";

describe("generateOpenAPI", () => {
  it("should generate valid OpenAPI 3.1 spec", () => {
    const routes = new Map<string, ProcedureDefinition>();
    routes.set("users.list", {
      type: "query",
      handler: async () => [],
      middlewares: [],
    });
    routes.set("users.create", {
      type: "mutation",
      handler: async () => ({}),
      middlewares: [],
    });

    const spec = generateOpenAPI(routes);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Celsian RPC API");
    expect(spec.paths["/_rpc/users.list"]).toBeDefined();
    expect(spec.paths["/_rpc/users.list"].get).toBeDefined();
    expect(spec.paths["/_rpc/users.create"]).toBeDefined();
    expect(spec.paths["/_rpc/users.create"].post).toBeDefined();
  });

  it("should use custom info", () => {
    const spec = generateOpenAPI(new Map(), {
      title: "My API",
      version: "2.0.0",
      description: "Test API",
    });
    expect(spec.info.title).toBe("My API");
    expect(spec.info.version).toBe("2.0.0");
    expect(spec.info.description).toBe("Test API");
  });

  it("should use custom base path", () => {
    const routes = new Map<string, ProcedureDefinition>();
    routes.set("ping", {
      type: "query",
      handler: async () => "pong",
      middlewares: [],
    });

    const spec = generateOpenAPI(routes, undefined, "/api/rpc");
    expect(spec.paths["/api/rpc/ping"]).toBeDefined();
  });

  it("should include schema info when present", () => {
    const routes = new Map<string, ProcedureDefinition>();
    routes.set("test", {
      type: "mutation",
      handler: async () => ({}),
      middlewares: [],
      inputSchema: {
        validate: () => ({ success: true }),
        toJsonSchema: () => ({ type: "object", properties: { name: { type: "string" } } }),
        _input: undefined as any,
        _output: undefined as any,
      },
      outputSchema: {
        validate: () => ({ success: true }),
        toJsonSchema: () => ({ type: "object", properties: { id: { type: "number" } } }),
        _input: undefined as any,
        _output: undefined as any,
      },
    });

    const spec = generateOpenAPI(routes);
    const op = spec.paths["/_rpc/test"].post as any;
    expect(op.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
    expect(op.responses["200"].content["application/json"].schema).toEqual({
      type: "object",
      properties: { id: { type: "number" } },
    });
  });
});
