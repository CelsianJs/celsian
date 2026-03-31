// @celsian/schema — Standard Schema interface

export interface SchemaResult<T = unknown> {
  success: boolean;
  data?: T;
  issues?: SchemaIssue[];
}

export interface SchemaIssue {
  message: string;
  path?: (string | number)[];
}

export interface StandardSchema<Input = unknown, Output = Input> {
  /** Validate input and return result */
  validate(input: unknown): SchemaResult<Output>;
  /** Get JSON Schema representation (for OpenAPI) */
  toJsonSchema(): Record<string, unknown>;
  /** The TypeScript input type (phantom) */
  _input: Input;
  /** The TypeScript output type (phantom) */
  _output: Output;
}

/**
 * Infer the output type from a schema.
 * Supports StandardSchema (`_output`), Zod-style (`_output`),
 * and TypeBox-style (`_type` / `static`) schemas.
 */
export type InferOutput<T> =
  T extends StandardSchema<unknown, infer O>
    ? O
    : T extends { _output: infer O }
      ? O
      : T extends { _type: infer O }
        ? O
        : unknown;
