// @celsian/rpc — Type definitions

import type { StandardSchema } from '@celsian/schema';

// ─── Context ───

export interface RPCContext {
  request: Request;
  [key: string]: unknown;
}

export type ContextFactory = (request: Request) => RPCContext | Promise<RPCContext>;

// ─── Procedure Types ───

export type ProcedureType = 'query' | 'mutation';

export interface ProcedureDefinition<
  TInput = unknown,
  TOutput = unknown,
> {
  type: ProcedureType;
  inputSchema?: StandardSchema<TInput>;
  outputSchema?: StandardSchema<TOutput>;
  handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TOutput>;
  middlewares: MiddlewareFunction[];
}

export type MiddlewareFunction = (opts: {
  ctx: RPCContext;
  next: () => Promise<unknown>;
}) => Promise<unknown>;

// ─── Router Types ───

export interface RouterDefinition {
  [key: string]: ProcedureDefinition | RouterDefinition;
}

export interface RPCManifest {
  procedures: Record<string, {
    type: ProcedureType;
    path: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }>;
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
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, Record<string, unknown>>;
}
