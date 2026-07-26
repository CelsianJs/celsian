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
 * - Valibot 1.x, `~types`
 * - any Standard Schema implementation, `~standard.types`
 *
 * The `static` branch matters because TypeBox is the schema library the default
 * `create-celsian` template installs: without it, every TypeBox-typed route and
 * procedure inferred `unknown`, forcing casts the docs claim are unnecessary.
 *
 * The `~types` / `~standard` branches matter for the same reason on Valibot,
 * which is one of the three libraries `@celsian/schema` adapts at runtime.
 * Valibot carries its output type on neither `_output`, `_type`, nor `static`,
 * so every Valibot-typed route inferred `unknown` and `request.parsedBody`
 * raised TS18046 even though validation worked perfectly at runtime.
 *
 * Both carriers are declared OPTIONAL by their libraries (`readonly "~types"?:
 * {...} | undefined`). A plain `T extends { "~types"?: ... }` check therefore
 * matches every object type, including ones with no such property, so the
 * branch has to be written as a `keyof` test plus `NonNullable` indexing.
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
          : "~types" extends keyof T
            ? NonNullable<T["~types"]> extends { output: infer O }
              ? O
              : unknown
            : "~standard" extends keyof T
              ? NonNullable<T["~standard"]> extends { types?: infer Types }
                ? NonNullable<Types> extends { output: infer O }
                  ? O
                  : unknown
                : unknown
              : unknown;
