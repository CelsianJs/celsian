// @celsian/rpc — Procedure builder

import type { StandardSchema } from '@celsian/schema';
import { fromSchema } from '@celsian/schema';
import type {
  ProcedureDefinition,
  ProcedureType,
  RPCContext,
  MiddlewareFunction,
} from './types.js';

class ProcedureBuilder<TInput = unknown, TOutput = unknown> {
  private _inputSchema?: StandardSchema<TInput>;
  private _outputSchema?: StandardSchema<TOutput>;
  private _middlewares: MiddlewareFunction[] = [];

  constructor(middlewares: MiddlewareFunction[] = []) {
    this._middlewares = [...middlewares];
  }

  input<T>(schema: unknown): ProcedureBuilder<T, TOutput> {
    const builder = new ProcedureBuilder<T, TOutput>(this._middlewares);
    builder._inputSchema = fromSchema<T>(schema) as StandardSchema<T>;
    builder._outputSchema = this._outputSchema as unknown as StandardSchema<TOutput> | undefined;
    return builder;
  }

  output<T>(schema: unknown): ProcedureBuilder<TInput, T> {
    const builder = new ProcedureBuilder<TInput, T>(this._middlewares);
    builder._inputSchema = this._inputSchema as unknown as StandardSchema<TInput> | undefined;
    builder._outputSchema = fromSchema<T>(schema) as StandardSchema<T>;
    return builder;
  }

  use(middleware: MiddlewareFunction): ProcedureBuilder<TInput, TOutput> {
    const builder = new ProcedureBuilder<TInput, TOutput>([...this._middlewares, middleware]);
    builder._inputSchema = this._inputSchema;
    builder._outputSchema = this._outputSchema;
    return builder;
  }

  query(
    handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TOutput> | TOutput,
  ): ProcedureDefinition<TInput, TOutput> {
    return this._build('query', handler);
  }

  mutation(
    handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TOutput> | TOutput,
  ): ProcedureDefinition<TInput, TOutput> {
    return this._build('mutation', handler);
  }

  private _build(
    type: ProcedureType,
    handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TOutput> | TOutput,
  ): ProcedureDefinition<TInput, TOutput> {
    return {
      type,
      inputSchema: this._inputSchema,
      outputSchema: this._outputSchema,
      handler: async (opts) => handler(opts) as Promise<TOutput>,
      middlewares: this._middlewares,
    };
  }
}

export const procedure = new ProcedureBuilder();

export function createProcedure(...middlewares: MiddlewareFunction[]): ProcedureBuilder {
  return new ProcedureBuilder(middlewares);
}
