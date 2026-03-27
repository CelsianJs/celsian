// @celsian/rpc — Router + handler execution

import { generateOpenAPI } from "./openapi.js";
import type {
  ContextFactory,
  ProcedureDefinition,
  RouterDefinition,
  RPCContext,
  RPCManifest,
  RPCResponse,
} from "./types.js";
import { decode, encode } from "./wire.js";

export function router<T extends RouterDefinition>(routes: T): T {
  return routes;
}

export class RPCHandler {
  private flatRoutes = new Map<string, ProcedureDefinition>();
  private contextFactory: ContextFactory;
  private basePath: string;

  constructor(
    routes: RouterDefinition,
    options?: {
      contextFactory?: ContextFactory;
      basePath?: string;
    },
  ) {
    this.contextFactory = options?.contextFactory ?? ((request) => ({ request }));
    this.basePath = options?.basePath ?? "/_rpc";
    this.flattenRoutes(routes, "");
  }

  private flattenRoutes(routes: RouterDefinition, prefix: string): void {
    for (const [key, value] of Object.entries(routes)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (this.isProcedure(value)) {
        this.flatRoutes.set(path, value as ProcedureDefinition);
      } else {
        this.flattenRoutes(value as RouterDefinition, path);
      }
    }
  }

  private isProcedure(value: unknown): value is ProcedureDefinition {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      "handler" in value &&
      ((value as ProcedureDefinition).type === "query" || (value as ProcedureDefinition).type === "mutation")
    );
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rpcPathRegex = new RegExp(`^${this.basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
    const rpcPath = url.pathname.replace(rpcPathRegex, "");

    if (rpcPath === "openapi.json") {
      return new Response(JSON.stringify(this.generateOpenAPI()), {
        headers: { "content-type": "application/json" },
      });
    }

    if (rpcPath === "manifest.json") {
      return new Response(JSON.stringify(this.getManifest()), {
        headers: { "content-type": "application/json" },
      });
    }

    const proc = this.flatRoutes.get(rpcPath);
    if (!proc) {
      return this.errorResponse(404, "NOT_FOUND", `Procedure "${rpcPath}" not found`);
    }

    if (proc.type === "mutation" && request.method !== "POST") {
      return this.errorResponse(405, "METHOD_NOT_ALLOWED", "Mutations require POST");
    }

    // Parse input
    let rawInput: unknown;
    if (request.method === "GET") {
      const inputParam = url.searchParams.get("input");
      if (inputParam) {
        try {
          rawInput = decode(JSON.parse(inputParam));
        } catch {
          return this.errorResponse(400, "PARSE_ERROR", "Invalid input parameter");
        }
      }
    } else {
      // Prefer pre-parsed body from CelsianApp (body stream already consumed)
      const preParsed = (request as unknown as Record<string, unknown>).parsedBody;
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        rawInput = preParsed instanceof FormData ? preParsed : await request.formData();
      } else {
        try {
          const body = preParsed !== undefined ? preParsed : await request.json();
          rawInput = decode(body);
        } catch {
          return this.errorResponse(400, "PARSE_ERROR", "Invalid JSON body");
        }
      }
    }

    // Validate input
    if (proc.inputSchema) {
      const result = proc.inputSchema.validate(rawInput);
      if (!result.success) {
        return this.errorResponse(400, "VALIDATION_ERROR", "Input validation failed", result.issues);
      }
      rawInput = result.data;
    }

    // Build context
    const ctx = await this.contextFactory(request);

    // Run middleware chain + handler
    try {
      const output = await this.runProcedure(proc, rawInput, ctx);

      if (proc.outputSchema) {
        const result = proc.outputSchema.validate(output);
        if (!result.success) {
          return this.errorResponse(500, "OUTPUT_VALIDATION_ERROR", "Output validation failed");
        }
      }

      const response: RPCResponse = { result: encode(output) };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      return this.errorResponse(status, code, message);
    }
  }

  private async runProcedure(proc: ProcedureDefinition, input: unknown, ctx: RPCContext): Promise<unknown> {
    const middlewares = proc.middlewares;
    let index = 0;

    const next = async (): Promise<unknown> => {
      if (index < middlewares.length) {
        const mw = middlewares[index++]!;
        return mw({ ctx, next });
      }
      return proc.handler({ input, ctx });
    };

    return next();
  }

  private errorResponse(
    status: number,
    code: string,
    message: string,
    issues?: Array<{ message: string; path?: (string | number)[] }>,
  ): Response {
    const response: RPCResponse = {
      error: { message, code, issues },
    };
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  getManifest(): RPCManifest {
    const procedures: RPCManifest["procedures"] = {};
    for (const [path, proc] of this.flatRoutes) {
      procedures[path] = {
        type: proc.type,
        path,
        inputSchema: proc.inputSchema?.toJsonSchema(),
        outputSchema: proc.outputSchema?.toJsonSchema(),
      };
    }
    return { procedures };
  }

  generateOpenAPI(info?: { title?: string; version?: string; description?: string }) {
    return generateOpenAPI(this.flatRoutes, info, this.basePath);
  }

  getRoutes(): Map<string, ProcedureDefinition> {
    return this.flatRoutes;
  }
}
