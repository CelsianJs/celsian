// @celsian/rpc, Procedure builder

import type { InferOutput, StandardSchema } from "@celsian/schema";
import { fromSchema } from "@celsian/schema";
import type { MiddlewareFunction, ProcedureDefinition, ProcedureType, RPCContext } from "./types.js";

/**
 * What a finalizing handler is allowed to return.
 *
 * Until `.output(schema)` pins it, `TOutput` is `unknown` and the handler may
 * return anything, its return type then becomes the procedure's output type.
 * Once an output schema is declared, the handler is constrained to it, so a
 * handler that contradicts its own declared output is a compile error rather
 * than a runtime validation failure.
 */
type HandlerResult<TOutput> = unknown extends TOutput ? unknown : TOutput;

/** The procedure's output type: the handler's return until `.output()` pins it. */
type ResolvedOutput<TOutput, TResult> = unknown extends TOutput ? Awaited<TResult> : TOutput;

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

  /**
   * Set the input validation schema (Zod, TypeBox, or Valibot).
   *
   * The type parameter is the SCHEMA, not the parsed type: that is the only
   * way TypeScript gets an inference site. The previous signature was
   * `input<T>(schema: unknown)`, which mentioned `T` nowhere in the parameter
   * list, so `T` had nothing to infer from and always collapsed to `unknown`,
   * leaving `({ input }) => ...` handlers untyped and falsifying the
   * end-to-end type safety the README advertises.
   */
  input<TSchema>(schema: TSchema): ProcedureBuilder<InferOutput<TSchema>, TOutput> {
    const builder = this._carry(new ProcedureBuilder<InferOutput<TSchema>, TOutput>(this._middlewares));
    builder._inputSchema = fromSchema<InferOutput<TSchema>>(schema) as StandardSchema<InferOutput<TSchema>>;
    builder._outputSchema = this._outputSchema as unknown as StandardSchema<TOutput> | undefined;
    return builder;
  }

  /** Set the output validation schema. Infers from the schema, see {@link input}. */
  output<TSchema>(schema: TSchema): ProcedureBuilder<TInput, InferOutput<TSchema>> {
    const builder = this._carry(new ProcedureBuilder<TInput, InferOutput<TSchema>>(this._middlewares));
    builder._inputSchema = this._inputSchema as unknown as StandardSchema<TInput> | undefined;
    builder._outputSchema = fromSchema<InferOutput<TSchema>>(schema) as StandardSchema<InferOutput<TSchema>>;
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

  /**
   * Finalize as a read-only query procedure (GET).
   *
   * `TResult` is inferred from the handler so the procedure carries a real
   * output type. Without it every procedure resolved to `Promise<unknown>` on
   * the client, which is half of what "end-to-end type safety" has to mean.
   */
  query<TResult extends HandlerResult<TOutput>>(
    handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TResult> | TResult,
  ): ProcedureDefinition<TInput, ResolvedOutput<TOutput, TResult>, "query"> {
    return this._build("query", handler);
  }

  /** Finalize as a write mutation procedure (POST). See {@link query} for the return inference. */
  mutation<TResult extends HandlerResult<TOutput>>(
    handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TResult> | TResult,
  ): ProcedureDefinition<TInput, ResolvedOutput<TOutput, TResult>, "mutation"> {
    return this._build("mutation", handler);
  }

  private _build<TType extends ProcedureType, TResult extends HandlerResult<TOutput>>(
    type: TType,
    handler: (opts: { input: TInput; ctx: RPCContext }) => Promise<TResult> | TResult,
  ): ProcedureDefinition<TInput, ResolvedOutput<TOutput, TResult>, TType> {
    type Out = ResolvedOutput<TOutput, TResult>;
    return {
      type,
      inputSchema: this._inputSchema,
      outputSchema: this._outputSchema as StandardSchema<Out> | undefined,
      handler: async (opts) => (await handler(opts)) as Out,
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
