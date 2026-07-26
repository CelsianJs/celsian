// @celsian/schema, Standard Schema interface

export interface SchemaResult<T = unknown> {
  success: boolean;
  data?: T;
  issues?: SchemaIssue[];
}

export interface SchemaIssue {
  message: string;
  path?: (string | number)[];
}

/**
 * Celsian's internal schema-adapter interface.
 *
 * NOTE: despite the name, this is a homegrown interface local to
 * `@celsian/schema`, it is NOT the `@standard-schema/spec` standard (which
 * uses a `~standard` property). Zod, TypeBox, and Valibot schemas are adapted
 * *into* this shape by {@link fromSchema}; libraries implementing the real
 * spec are detected via their `~standard` property, not by this type.
 */
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
 *
 * Supported carriers, in order:
 * - {@link StandardSchema} (our adapters), `_output`
 * - Zod v3, `_output`
 * - legacy TypeBox / misc, `_type`
 * - TypeBox (0.30+, incl. 0.34), `static`
 *
 * The `static` branch matters because TypeBox is the schema library the default
 * `create-celsian` template installs: without it, every TypeBox-typed route and
 * procedure inferred `unknown`, forcing casts the docs claim are unnecessary.
 * It is checked last so it can never shadow the more specific carriers.
 */
export type InferOutput<T> =
  T extends StandardSchema<unknown, infer O>
    ? O
    : T extends { _output: infer O }
      ? O
      : T extends { _type: infer O }
        ? O
        : T extends { static: infer O }
          ? O
          : unknown;
