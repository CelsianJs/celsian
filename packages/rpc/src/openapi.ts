// @celsian/rpc — OpenAPI 3.1 generation

import type { OpenAPISpec, ProcedureDefinition } from "./types.js";

export function generateOpenAPI(
  flatRoutes: Map<string, ProcedureDefinition>,
  info?: { title?: string; version?: string; description?: string },
  basePath = "/_rpc",
): OpenAPISpec {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [path, proc] of flatRoutes) {
    const urlPath = `${basePath}/${path}`;
    const method = proc.type === "query" ? "get" : "post";

    const operation: Record<string, unknown> = {
      operationId: path,
      tags: [path.split(".")[0]],
      summary: path,
    };

    if (proc.inputSchema) {
      const schema = proc.inputSchema.toJsonSchema();
      if (method === "get") {
        operation.parameters = [
          {
            name: "input",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "JSON-encoded input",
          },
        ];
      } else {
        operation.requestBody = {
          required: true,
          content: {
            "application/json": { schema },
          },
        };
      }
    }

    if (proc.outputSchema) {
      operation.responses = {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema: proc.outputSchema.toJsonSchema(),
            },
          },
        },
      };
    } else {
      operation.responses = {
        "200": { description: "Successful response" },
      };
    }

    paths[urlPath] = { [method]: operation };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: info?.title ?? "Celsian RPC API",
      version: info?.version ?? "1.0.0",
      description: info?.description,
    },
    paths,
  };
}
