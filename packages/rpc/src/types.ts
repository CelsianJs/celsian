// @celsian/rpc — Type definitions

import type { StandardSchema } from "@celsian/schema";

// ─── Context ───

/** Request context passed to every procedure handler and middleware. */
export interface RPCContext {
  request: Request;
  [key: string]: unknown;
}

/** Factory function that creates an RPCContext from the raw Request (e.g., to inject auth). */
export type ContextFactory = (request: Request) => RPCContext | Promise<RPCContext>;

// ─── Procedure Types ───

export type ProcedureType = "query" | "mutation";

/** Fully resolved procedure with type, schemas, handler, and middleware chain. */
export interface ProcedureDefinition<TInput = unknown, TOutput = unknown> {
  type: ProcedureType;
  inputSchema?: StandardSchema<TInput>;
  outputSchema?: StandardSchema<TOutput>;
  handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TOutput>;
  middlewares: MiddlewareFunction[];
}

/** RPC middleware -- receives context and a `next()` function for the chain. */
export type MiddlewareFunction = (opts: { ctx: RPCContext; next: () => Promise<unknown> }) => Promise<unknown>;

// ─── Router Types ───

/** Nested object of procedures and sub-routers. */
export interface RouterDefinition {
  [key: string]: ProcedureDefinition | RouterDefinition;
}

/** JSON-serializable manifest listing all procedures with their types and schemas. */
export interface RPCManifest {
  procedures: Record<
    string,
    {
      type: ProcedureType;
      path: string;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }
  >;
}

// ─── Wire Protocol ───

export interface RPCRequest {
  path: string;
  input?: unknown;
}

export interface RPCResponse<T = unknown> {
  result?: T;
  error?: {
    message: string;
    code: string;
    issues?: Array<{ message: string; path?: (string | number)[] }>;
  };
}

// ─── Tagged Encoding ───

export interface TaggedValue {
  __t: string;
  v: string;
}

// ─── OpenAPI ───

export interface OpenAPISpec {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, Record<string, unknown>>;
}
