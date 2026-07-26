// @celsian/rpc, Procedure builder

import type { StandardSchema } from "@celsian/schema";
import { fromSchema } from "@celsian/schema";
import type { MiddlewareFunction, ProcedureDefinition, ProcedureType, RPCContext } from "./types.js";

/**
 * Fluent builder for defining RPC procedures with optional input/output schemas and middleware.
 * Chain `.input()`, `.output()`, `.use()`, then finalize with `.query()` or `.mutation()`.
 */
class ProcedureBuilder<TInput = unknown, TOutput = unknown> {
  private _inputSchema?: StandardSchema<TInput>;
  private _outputSchema?: StandardSchema<TOutput>;
  private _middlewares: MiddlewareFunction[] = [];
  private _allowFormData = false;

  constructor(middlewares: MiddlewareFunction[] = []) {
    this._middlewares = [...middlewares];
  }

  /**
   * Copy the settings that are not being replaced onto a freshly branched
   * builder. Each chain step returns a new builder (so a shared base builder is
   * never mutated), and every setting has to survive that hop.
   */
  private _carry<A, B>(next: ProcedureBuilder<A, B>): ProcedureBuilder<A, B> {
    next._allowFormData = this._allowFormData;
    return next;
  }

  /** Set the input validation schema (Zod, TypeBox, or Valibot). */
  input<T>(schema: unknown): ProcedureBuilder<T, TOutput> {
    const builder = this._carry(new ProcedureBuilder<T, TOutput>(this._middlewares));
    builder._inputSchema = fromSchema<T>(schema) as StandardSchema<T>;
    builder._outputSchema = this._outputSchema as unknown as StandardSchema<TOutput> | undefined;
    return builder;
  }

  /** Set the output validation schema. */
  output<T>(schema: unknown): ProcedureBuilder<TInput, T> {
    const builder = this._carry(new ProcedureBuilder<TInput, T>(this._middlewares));
    builder._inputSchema = this._inputSchema as unknown as StandardSchema<TInput> | undefined;
    builder._outputSchema = fromSchema<T>(schema) as StandardSchema<T>;
    return builder;
  }

  /** Add a middleware function to the procedure chain. */
  use(middleware: MiddlewareFunction): ProcedureBuilder<TInput, TOutput> {
    const builder = this._carry(new ProcedureBuilder<TInput, TOutput>([...this._middlewares, middleware]));
    builder._inputSchema = this._inputSchema;
    builder._outputSchema = this._outputSchema;
    return builder;
  }

  /**
   * Accept `multipart/form-data` / `application/x-www-form-urlencoded` bodies
   * for this procedure (file uploads). Off by default, because those are CORS
   * *simple* content types: a cross-origin `<form>` can post to them with the
   * victim's cookies and no preflight. Only opt in where you actually need it,
   * and keep the handler's origin check (or an app-level CSRF token) on.
   */
  allowFormData(): ProcedureBuilder<TInput, TOutput> {
    const builder = this._carry(new ProcedureBuilder<TInput, TOutput>(this._middlewares));
    builder._inputSchema = this._inputSchema;
    builder._outputSchema = this._outputSchema;
    builder._allowFormData = true;
    return builder;
  }

  /** Finalize as a read-only query procedure (GET). */
  query(
    handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TOutput> | TOutput,
  ): ProcedureDefinition<TInput, TOutput, "query"> {
    return this._build("query", handler);
  }

  /** Finalize as a write mutation procedure (POST). */
  mutation(
    handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TOutput> | TOutput,
  ): ProcedureDefinition<TInput, TOutput, "mutation"> {
    return this._build("mutation", handler);
  }

  private _build<TType extends ProcedureType>(
    type: TType,
    handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TOutput> | TOutput,
  ): ProcedureDefinition<TInput, TOutput, TType> {
    return {
      type,
      inputSchema: this._inputSchema,
      outputSchema: this._outputSchema,
      handler: async (opts) => handler(opts) as Promise<TOutput>,
      middlewares: this._middlewares,
      allowFormData: this._allowFormData,
    };
  }
}

/** Default procedure builder instance -- start chaining with `procedure.input(...)`. */
export const procedure = new ProcedureBuilder();

/** Create a procedure builder with pre-applied middleware (e.g., auth). */
export function createProcedure(...middlewares: MiddlewareFunction[]): ProcedureBuilder {
  return new ProcedureBuilder(middlewares);
}
