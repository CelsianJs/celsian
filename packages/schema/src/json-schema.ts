// @celsian/schema, JSON Schema conversion for Zod and Valibot schemas

/**
 * Zod and Valibot both refuse to describe themselves as JSON Schema through any
 * interface Celsian can call synchronously:
 *
 * - Zod 3 has no JSON Schema export at all. Zod 4 has one, but it is the
 *   top-level `z.toJSONSchema()` function, not a method on the schema, so
 *   reaching it would mean importing `zod` (an OPTIONAL peer dependency) at
 *   runtime, and Celsian must keep working when it is not installed.
 * - Valibot has `@valibot/to-json-schema`, a separate package.
 *
 * Both adapters therefore used to answer `{ type: "object" }`, and the OpenAPI
 * plugin published exactly that: a documented API with zero documented fields.
 * This module converts the two libraries' internal schema representations
 * directly, with no dependency on either package being installed.
 *
 * Anything the converters do not recognize becomes `{}` (JSON Schema for "any
 * value") rather than throwing: an OpenAPI document with one under-described
 * field is worth far more than no document at all.
 */

/** A JSON Schema fragment. */
export type JsonSchemaObject = Record<string, unknown>;

/** Recursion budget. Guards against pathological nesting and `lazy()` cycles. */
const MAX_DEPTH = 32;

interface ConvertContext {
  /** Schema nodes already on the current branch, so cycles terminate. */
  seen: Set<unknown>;
  depth: number;
}

function newContext(): ConvertContext {
  return { seen: new Set(), depth: 0 };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<PropertyKey, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** `RegExp.source` when `value` is a RegExp, otherwise undefined. */
function regexSource(value: unknown): string | undefined {
  return value instanceof RegExp ? value.source : undefined;
}

/**
 * Attach a `description` when the schema carries one. Both Zod 3 (`_def`) and
 * Zod 4 (global registry) expose it through the same `.description` getter.
 */
function withDescription(json: JsonSchemaObject, node: Record<PropertyKey, unknown>): JsonSchemaObject {
  const description = asString(node.description);
  if (description !== undefined && json.description === undefined) {
    json.description = description;
  }
  return json;
}

/**
 * Make a schema accept `null` as well. OpenAPI 3.1 is JSON Schema 2020-12, so
 * the type-array spelling is legal there, unlike OpenAPI 3.0's `nullable: true`.
 */
function nullable(inner: JsonSchemaObject): JsonSchemaObject {
  const type = inner.type;
  if (typeof type === "string") {
    return { ...inner, type: [type, "null"] };
  }
  if (Array.isArray(type)) {
    return type.includes("null") ? inner : { ...inner, type: [...type, "null"] };
  }
  return { anyOf: [inner, { type: "null" }] };
}

/**
 * The real members of an enum object.
 *
 * A numeric TypeScript enum compiles to a two-way map (`{ A: 0, 0: "A" }`), and
 * both Zod 3's `nativeEnum` and Zod 4's `enum` hand that whole object over. Only
 * the forward entries are members; the reverse ones would document `"A"` as a
 * legal value of a numeric enum.
 */
function enumMembers(entries: Record<PropertyKey, unknown> | undefined): unknown[] {
  if (!entries) return [];
  return Object.entries(entries)
    .filter(([key, value]) => !(/^\d+$/.test(key) && typeof value === "string" && entries[value] === Number(key)))
    .map(([, value]) => value);
}

/** Build `const`/`enum` for a set of literal values. */
function literalSchema(values: readonly unknown[]): JsonSchemaObject {
  const types = new Set(values.map((v) => (v === null ? "null" : typeof v)));
  const json: JsonSchemaObject = {};
  if (types.size === 1) {
    const only = [...types][0];
    if (only === "string" || only === "number" || only === "boolean" || only === "null") {
      json.type = only;
    } else if (only === "bigint") {
      json.type = "integer";
    }
  }
  if (values.length === 1) {
    json.const = values[0];
  } else {
    json.enum = [...values];
  }
  return json;
}

// ─── Zod ───

// Both Zod majors are supported on purpose: the package's peer range is
// `zod: >=3.0.0` and the branches below exist to honour it. The repository is
// wired to actually exercise both, and it is easy to undo by accident: the
// packages dev-depend on Zod 4 while the workspace ROOT stays on Zod 3, which
// is what `internal/` and the examples resolve. Bumping the root to 4, which
// Dependabot proposes, would leave every Zod 3 branch here untested while the
// peer range still promises them. Keep the root on 3 until the peer range drops
// it.

/** Zod 3 exposes `_def.typeName`; Zod 4 exposes `_zod.def.type`. */
function zodDef(node: Record<PropertyKey, unknown>): { version: 3 | 4; def: Record<PropertyKey, unknown> } | undefined {
  const zod4 = asRecord(node._zod);
  const def4 = zod4 && asRecord(zod4.def);
  if (def4 && typeof def4.type === "string") return { version: 4, def: def4 };

  const def3 = asRecord(node._def);
  if (def3 && typeof def3.typeName === "string") return { version: 3, def: def3 };

  return undefined;
}

/** True when this Zod schema makes its object key optional. */
function isZodOptionalMember(node: unknown): boolean {
  const record = asRecord(node);
  if (!record) return false;
  const found = zodDef(record);
  if (!found) return false;
  if (found.version === 4) {
    const optin = asRecord(record._zod)?.optin;
    if (optin === "optional") return true;
    return found.def.type === "optional" || found.def.type === "default" || found.def.type === "prefault";
  }
  const typeName = found.def.typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}

/** Zod 3 string check kinds that map onto a JSON Schema `format`. */
const ZOD3_STRING_FORMATS: Record<string, string> = {
  email: "email",
  url: "uri",
  uuid: "uuid",
  datetime: "date-time",
  date: "date",
  time: "time",
  duration: "duration",
};

/** Zod 4 `format` tags (also used by Valibot action names) mapped to JSON Schema. */
const ZOD4_STRING_FORMATS: Record<string, string> = {
  email: "email",
  url: "uri",
  uuid: "uuid",
  guid: "uuid",
  datetime: "date-time",
  date: "date",
  time: "time",
  duration: "duration",
  ipv4: "ipv4",
  ipv6: "ipv6",
};

function applyZod3StringChecks(json: JsonSchemaObject, checks: unknown[]): void {
  for (const raw of checks) {
    const check = asRecord(raw);
    if (!check) continue;
    const kind = asString(check.kind);
    const value = asNumber(check.value);
    switch (kind) {
      case "min":
        if (value !== undefined) json.minLength = value;
        break;
      case "max":
        if (value !== undefined) json.maxLength = value;
        break;
      case "length":
        if (value !== undefined) {
          json.minLength = value;
          json.maxLength = value;
        }
        break;
      case "regex": {
        const source = regexSource(check.regex);
        if (source !== undefined) json.pattern = source;
        break;
      }
      case "ip": {
        const version = asString(check.version);
        if (version === "v4") json.format = "ipv4";
        else if (version === "v6") json.format = "ipv6";
        break;
      }
      default: {
        const format = kind !== undefined ? ZOD3_STRING_FORMATS[kind] : undefined;
        if (format !== undefined) json.format = format;
      }
    }
  }
}

function applyZod3NumberChecks(json: JsonSchemaObject, checks: unknown[]): void {
  for (const raw of checks) {
    const check = asRecord(raw);
    if (!check) continue;
    const kind = asString(check.kind);
    const value = asNumber(check.value);
    if (kind === "int") {
      json.type = "integer";
    } else if (kind === "min" && value !== undefined) {
      if (check.inclusive === false) json.exclusiveMinimum = value;
      else json.minimum = value;
    } else if (kind === "max" && value !== undefined) {
      if (check.inclusive === false) json.exclusiveMaximum = value;
      else json.maximum = value;
    } else if (kind === "multipleOf" && value !== undefined) {
      json.multipleOf = value;
    }
  }
}

/** Safe-integer bounds Zod 4 stamps on every `z.int()`, which are noise in a spec. */
const SAFE_INT_MIN = Number.MIN_SAFE_INTEGER;
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Zod 4 accumulates resolved constraints on `_zod.bag` (`{ minimum, maximum,
 * multipleOf, format, pattern }`), which is far more stable to read than the
 * individual check instances.
 */
function zod4Bag(node: Record<PropertyKey, unknown>): Record<PropertyKey, unknown> {
  return asRecord(asRecord(node._zod)?.bag) ?? {};
}

/** True when a Zod 4 numeric check marks its bound exclusive. */
function zod4HasExclusive(def: Record<PropertyKey, unknown>, checkName: string): boolean {
  const checks = asArray(def.checks);
  if (!checks) return false;
  return checks.some((raw) => {
    const inner = asRecord(asRecord(asRecord(raw)?._zod)?.def);
    return inner?.check === checkName && inner.inclusive === false;
  });
}

function zod4String(node: Record<PropertyKey, unknown>, def: Record<PropertyKey, unknown>): JsonSchemaObject {
  const bag = zod4Bag(node);
  const json: JsonSchemaObject = { type: "string" };
  const min = asNumber(bag.minimum);
  const max = asNumber(bag.maximum);
  if (min !== undefined) json.minLength = min;
  if (max !== undefined) json.maxLength = max;
  const format = asString(bag.format) ?? asString(def.format);
  const mapped = format !== undefined ? ZOD4_STRING_FORMATS[format] : undefined;
  if (mapped !== undefined) json.format = mapped;
  const pattern = zod4Pattern(bag);
  if (pattern !== undefined && mapped === undefined) json.pattern = pattern;
  return json;
}

/**
 * The regex a Zod 4 string schema enforces. `.regex()` records it in the
 * `patterns` SET rather than as a single `pattern`, so a schema with several
 * regex checks keeps them all; JSON Schema takes one, so the first wins.
 */
function zod4Pattern(bag: Record<PropertyKey, unknown>): string | undefined {
  const single = regexSource(bag.pattern);
  if (single !== undefined) return single;
  const patterns = bag.patterns;
  if (patterns instanceof Set) {
    for (const candidate of patterns) {
      const source = regexSource(candidate);
      if (source !== undefined) return source;
    }
  }
  return undefined;
}

function zod4Number(node: Record<PropertyKey, unknown>, def: Record<PropertyKey, unknown>): JsonSchemaObject {
  const bag = zod4Bag(node);
  const format = asString(bag.format) ?? asString(def.format);
  const isInteger = format !== undefined && /int/i.test(format);
  const json: JsonSchemaObject = { type: isInteger ? "integer" : "number" };
  const min = asNumber(bag.minimum);
  const max = asNumber(bag.maximum);
  // `z.int()` stamps the JS safe-integer range on every schema. Publishing it
  // would document a bound the developer never wrote.
  if (min !== undefined && !(isInteger && min === SAFE_INT_MIN)) {
    if (zod4HasExclusive(def, "greater_than")) json.exclusiveMinimum = min;
    else json.minimum = min;
  }
  if (max !== undefined && !(isInteger && max === SAFE_INT_MAX)) {
    if (zod4HasExclusive(def, "less_than")) json.exclusiveMaximum = max;
    else json.maximum = max;
  }
  const multipleOf = asNumber(bag.multipleOf);
  if (multipleOf !== undefined) json.multipleOf = multipleOf;
  return json;
}

function applyLengthBag(node: Record<PropertyKey, unknown>, json: JsonSchemaObject): void {
  const bag = zod4Bag(node);
  const min = asNumber(bag.minimum);
  const max = asNumber(bag.maximum);
  if (min !== undefined) json.minItems = min;
  if (max !== undefined) json.maxItems = max;
}

function convertZodNode(node: unknown, ctx: ConvertContext): JsonSchemaObject {
  const record = asRecord(node);
  if (!record) return {};
  if (ctx.depth > MAX_DEPTH || ctx.seen.has(record)) return {};

  const found = zodDef(record);
  if (!found) return {};

  ctx.seen.add(record);
  ctx.depth += 1;
  try {
    // Zod 4 keeps its resolved constraints on the schema instance (`_zod.bag`)
    // rather than on the def, so its converter needs the node itself. Zod 3
    // puts everything on `_def`.
    const json = found.version === 4 ? convertZod4(record, found.def, ctx) : convertZod3(found.def, ctx);
    return withDescription(json, record);
  } finally {
    ctx.depth -= 1;
    ctx.seen.delete(record);
  }
}

function convertZod3(def: Record<PropertyKey, unknown>, ctx: ConvertContext): JsonSchemaObject {
  const typeName = asString(def.typeName);
  switch (typeName) {
    case "ZodString": {
      const json: JsonSchemaObject = { type: "string" };
      applyZod3StringChecks(json, asArray(def.checks) ?? []);
      return json;
    }
    case "ZodNumber": {
      const json: JsonSchemaObject = { type: "number" };
      applyZod3NumberChecks(json, asArray(def.checks) ?? []);
      return json;
    }
    case "ZodNaN":
      return { type: "number" };
    case "ZodBigInt":
      return { type: "integer", format: "int64" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodDate":
      return { type: "string", format: "date-time" };
    case "ZodNull":
      return { type: "null" };
    case "ZodLiteral":
      return literalSchema([def.value]);
    case "ZodEnum":
      return literalSchema(asArray(def.values) ?? []);
    case "ZodNativeEnum":
      return literalSchema(enumMembers(asRecord(def.values)));
    case "ZodArray": {
      const json: JsonSchemaObject = { type: "array", items: convertZodNode(def.type, ctx) };
      const min = asNumber(asRecord(def.minLength)?.value);
      const max = asNumber(asRecord(def.maxLength)?.value);
      const exact = asNumber(asRecord(def.exactLength)?.value);
      if (min !== undefined) json.minItems = min;
      if (max !== undefined) json.maxItems = max;
      if (exact !== undefined) {
        json.minItems = exact;
        json.maxItems = exact;
      }
      return json;
    }
    case "ZodObject": {
      const shapeSource = def.shape;
      const shape = typeof shapeSource === "function" ? asRecord(shapeSource()) : asRecord(shapeSource);
      return objectSchema(shape, ctx, convertZodNode, isZodOptionalMember, zod3AdditionalProperties(def, ctx));
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = asArray(def.options) ?? [...((asRecord(def.options)?.values as unknown[] | undefined) ?? [])];
      return { anyOf: options.map((option) => convertZodNode(option, ctx)) };
    }
    case "ZodIntersection":
      return { allOf: [convertZodNode(def.left, ctx), convertZodNode(def.right, ctx)] };
    case "ZodTuple": {
      const items = asArray(def.items) ?? [];
      const json: JsonSchemaObject = {
        type: "array",
        prefixItems: items.map((item) => convertZodNode(item, ctx)),
      };
      json.items = def.rest != null ? convertZodNode(def.rest, ctx) : false;
      return json;
    }
    case "ZodRecord":
      return { type: "object", additionalProperties: convertZodNode(def.valueType, ctx) };
    case "ZodMap":
      return {
        type: "array",
        items: {
          type: "array",
          prefixItems: [convertZodNode(def.keyType, ctx), convertZodNode(def.valueType, ctx)],
          items: false,
        },
      };
    case "ZodSet":
      return { type: "array", items: convertZodNode(def.valueType, ctx), uniqueItems: true };
    case "ZodOptional":
      return convertZodNode(def.innerType, ctx);
    case "ZodNullable":
      return nullable(convertZodNode(def.innerType, ctx));
    case "ZodDefault": {
      const json = convertZodNode(def.innerType, ctx);
      const defaultValue = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
      if (defaultValue !== undefined) json.default = defaultValue;
      return json;
    }
    case "ZodCatch":
    case "ZodReadonly":
      return convertZodNode(def.innerType, ctx);
    case "ZodBranded":
      return convertZodNode(def.type, ctx);
    case "ZodEffects":
      return convertZodNode(def.schema, ctx);
    case "ZodPipeline":
      // The input side is what a request body must satisfy.
      return convertZodNode(def.in, ctx);
    case "ZodLazy":
      return typeof def.getter === "function" ? convertZodNode(def.getter(), ctx) : {};
    case "ZodPromise":
      return convertZodNode(def.type, ctx);
    case "ZodNever":
      return { not: {} };
    default:
      // ZodAny, ZodUnknown, ZodVoid, ZodUndefined, ZodSymbol, ZodFunction and
      // anything a future Zod adds: "any value".
      return {};
  }
}

/** `additionalProperties` for a Zod 3 object, from its unknown-key policy. */
function zod3AdditionalProperties(def: Record<PropertyKey, unknown>, ctx: ConvertContext): unknown {
  const unknownKeys = asString(def.unknownKeys);
  if (unknownKeys === "strict") return false;
  if (unknownKeys === "passthrough") return true;
  const catchall = asRecord(def.catchall);
  const catchallName = catchall && asString(asRecord(catchall._def)?.typeName);
  if (catchallName !== undefined && catchallName !== "ZodNever") {
    return convertZodNode(catchall, ctx);
  }
  return undefined;
}

function convertZod4(
  node: Record<PropertyKey, unknown>,
  def: Record<PropertyKey, unknown>,
  ctx: ConvertContext,
): JsonSchemaObject {
  const type = asString(def.type);
  switch (type) {
    case "string":
    case "template_literal":
      return zod4String(node, def);
    case "number":
    case "int":
      return zod4Number(node, def);
    case "nan":
      return { type: "number" };
    case "bigint":
      return { type: "integer", format: "int64" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "file":
      return { type: "string", format: "binary" };
    case "null":
      return { type: "null" };
    case "literal":
      return literalSchema(asArray(def.values) ?? []);
    case "enum":
      return literalSchema(enumMembers(asRecord(def.entries)));
    case "array": {
      const json: JsonSchemaObject = { type: "array", items: convertZodNode(def.element, ctx) };
      applyLengthBag(node, json);
      return json;
    }
    case "object":
    case "interface": {
      const catchall = def.catchall;
      const catchallType = asString(asRecord(asRecord(asRecord(catchall)?._zod)?.def)?.type);
      let additional: unknown;
      if (catchallType === "never") additional = false;
      else if (catchallType === "unknown" || catchallType === "any") additional = true;
      else if (catchall != null) additional = convertZodNode(catchall, ctx);
      return objectSchema(asRecord(def.shape), ctx, convertZodNode, isZodOptionalMember, additional);
    }
    case "union":
      return { anyOf: (asArray(def.options) ?? []).map((option) => convertZodNode(option, ctx)) };
    case "intersection":
      return { allOf: [convertZodNode(def.left, ctx), convertZodNode(def.right, ctx)] };
    case "tuple": {
      const json: JsonSchemaObject = {
        type: "array",
        prefixItems: (asArray(def.items) ?? []).map((item) => convertZodNode(item, ctx)),
      };
      json.items = def.rest != null ? convertZodNode(def.rest, ctx) : false;
      return json;
    }
    case "record":
      return { type: "object", additionalProperties: convertZodNode(def.valueType, ctx) };
    case "map":
      return {
        type: "array",
        items: {
          type: "array",
          prefixItems: [convertZodNode(def.keyType, ctx), convertZodNode(def.valueType, ctx)],
          items: false,
        },
      };
    case "set":
      return { type: "array", items: convertZodNode(def.valueType, ctx), uniqueItems: true };
    case "optional":
    case "nonoptional":
    case "readonly":
    case "catch":
    case "success":
      return convertZodNode(def.innerType, ctx);
    case "nullable":
      return nullable(convertZodNode(def.innerType, ctx));
    case "default":
    case "prefault": {
      const json = convertZodNode(def.innerType, ctx);
      const defaultValue = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
      if (defaultValue !== undefined) json.default = defaultValue;
      return json;
    }
    case "pipe":
      // `.transform()` and `.pipe()` both land here; the input side is what a
      // caller has to send.
      return convertZodNode(def.in, ctx);
    case "lazy":
      return typeof def.getter === "function" ? convertZodNode(def.getter(), ctx) : {};
    case "promise":
      return convertZodNode(def.innerType, ctx);
    case "never":
      return { not: {} };
    default:
      return {};
  }
}

// ─── Valibot ───

/** Valibot wrapper types that make an object entry optional. */
const VALIBOT_OPTIONAL_TYPES = new Set(["optional", "exact_optional", "nullish", "undefinedable"]);

function isValibotOptionalMember(node: unknown): boolean {
  const type = asString(asRecord(node)?.type);
  return type !== undefined && VALIBOT_OPTIONAL_TYPES.has(type);
}

/** Valibot validation-action names that map onto a JSON Schema `format`. */
const VALIBOT_FORMATS: Record<string, string> = {
  email: "email",
  url: "uri",
  uuid: "uuid",
  ipv4: "ipv4",
  ipv6: "ipv6",
  iso_date: "date",
  iso_time: "time",
  iso_timestamp: "date-time",
  iso_date_time: "date-time",
};

/** Fold a Valibot pipe action (`v.minLength(2)`, `v.email()`, …) into `json`. */
function applyValibotAction(json: JsonSchemaObject, action: Record<PropertyKey, unknown>): void {
  const kind = asString(action.kind);
  if (kind === "metadata") {
    const type = asString(action.type);
    if (type === "description") {
      const description = asString(action.description);
      if (description !== undefined) json.description = description;
    } else if (type === "title") {
      const title = asString(action.title);
      if (title !== undefined) json.title = title;
    }
    return;
  }
  if (kind !== "validation") return;

  const type = asString(action.type);
  const requirement = asNumber(action.requirement);
  const isCollection = json.type === "array";
  switch (type) {
    case "min_length":
      if (requirement !== undefined) json[isCollection ? "minItems" : "minLength"] = requirement;
      break;
    case "max_length":
      if (requirement !== undefined) json[isCollection ? "maxItems" : "maxLength"] = requirement;
      break;
    case "length":
      if (requirement !== undefined) {
        json[isCollection ? "minItems" : "minLength"] = requirement;
        json[isCollection ? "maxItems" : "maxLength"] = requirement;
      }
      break;
    case "non_empty":
      json[isCollection ? "minItems" : "minLength"] = 1;
      break;
    case "min_value":
      if (requirement !== undefined) json.minimum = requirement;
      break;
    case "max_value":
      if (requirement !== undefined) json.maximum = requirement;
      break;
    case "gt_value":
      if (requirement !== undefined) json.exclusiveMinimum = requirement;
      break;
    case "lt_value":
      if (requirement !== undefined) json.exclusiveMaximum = requirement;
      break;
    case "multiple_of":
      if (requirement !== undefined) json.multipleOf = requirement;
      break;
    case "integer":
      if (json.type === "number") json.type = "integer";
      break;
    case "regex": {
      const source = regexSource(action.requirement);
      if (source !== undefined) json.pattern = source;
      break;
    }
    default: {
      const format = type !== undefined ? VALIBOT_FORMATS[type] : undefined;
      if (format !== undefined) json.format = format;
    }
  }
}

function convertValibotNode(node: unknown, ctx: ConvertContext): JsonSchemaObject {
  const record = asRecord(node);
  if (!record) return {};
  if (ctx.depth > MAX_DEPTH || ctx.seen.has(record)) return {};
  if (record.kind !== "schema") return {};

  ctx.seen.add(record);
  ctx.depth += 1;
  try {
    const pipe = asArray(record.pipe);
    if (pipe && pipe.length > 0) {
      // A piped schema repeats its base schema at `pipe[0]` and then lists the
      // actions. Converting `record` itself here would recurse forever.
      const base = asRecord(pipe[0]);
      const json = base && base !== record ? convertValibotBase(base, ctx) : convertValibotBase(record, ctx, true);
      for (const rawAction of pipe.slice(1)) {
        const action = asRecord(rawAction);
        if (action) applyValibotAction(json, action);
      }
      return json;
    }
    return convertValibotBase(record, ctx);
  } finally {
    ctx.depth -= 1;
    ctx.seen.delete(record);
  }
}

function convertValibotBase(
  node: Record<PropertyKey, unknown>,
  ctx: ConvertContext,
  ignorePipe = false,
): JsonSchemaObject {
  if (!ignorePipe) {
    const pipe = asArray(node.pipe);
    if (pipe && pipe.length > 0) return convertValibotNode(node, ctx);
  }

  const type = asString(node.type);
  switch (type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "bigint":
      return { type: "integer", format: "int64" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "blob":
    case "file":
      return { type: "string", format: "binary" };
    case "null":
      return { type: "null" };
    case "literal":
      return literalSchema([node.literal]);
    case "picklist":
      return literalSchema(asArray(node.options) ?? []);
    case "enum": {
      const members = asRecord(node.enum);
      return literalSchema(members ? enumMembers(members) : (asArray(node.options) ?? []));
    }
    case "array":
      return { type: "array", items: convertValibotNode(node.item, ctx) };
    case "set":
      return { type: "array", items: convertValibotNode(node.value, ctx), uniqueItems: true };
    case "tuple":
    case "tuple_with_rest": {
      const json: JsonSchemaObject = {
        type: "array",
        prefixItems: (asArray(node.items) ?? []).map((item) => convertValibotNode(item, ctx)),
      };
      json.items = node.rest != null ? convertValibotNode(node.rest, ctx) : false;
      return json;
    }
    case "object":
      return objectSchema(asRecord(node.entries), ctx, convertValibotNode, isValibotOptionalMember, undefined);
    case "loose_object":
      return objectSchema(asRecord(node.entries), ctx, convertValibotNode, isValibotOptionalMember, true);
    case "strict_object":
      return objectSchema(asRecord(node.entries), ctx, convertValibotNode, isValibotOptionalMember, false);
    case "object_with_rest":
      return objectSchema(
        asRecord(node.entries),
        ctx,
        convertValibotNode,
        isValibotOptionalMember,
        convertValibotNode(node.rest, ctx),
      );
    case "record":
      return { type: "object", additionalProperties: convertValibotNode(node.value, ctx) };
    case "map":
      return {
        type: "array",
        items: {
          type: "array",
          prefixItems: [convertValibotNode(node.key, ctx), convertValibotNode(node.value, ctx)],
          items: false,
        },
      };
    case "union":
    case "variant":
      return { anyOf: (asArray(node.options) ?? []).map((option) => convertValibotNode(option, ctx)) };
    case "intersect":
      return { allOf: (asArray(node.options) ?? []).map((option) => convertValibotNode(option, ctx)) };
    case "optional":
    case "exact_optional":
    case "undefinedable":
    case "non_optional":
    case "non_nullable":
    case "non_nullish":
      return applyValibotDefault(convertValibotNode(node.wrapped, ctx), node);
    case "nullable":
    case "nullish":
      return applyValibotDefault(nullable(convertValibotNode(node.wrapped, ctx)), node);
    case "lazy":
      return typeof node.getter === "function" ? convertValibotNode(node.getter(undefined), ctx) : {};
    case "never":
      return { not: {} };
    default:
      // any, unknown, void, undefined, symbol, function, custom, promise, …
      return {};
  }
}

/** Carry a Valibot wrapper's `default` onto the converted inner schema. */
function applyValibotDefault(json: JsonSchemaObject, node: Record<PropertyKey, unknown>): JsonSchemaObject {
  const raw = node.default;
  const value = typeof raw === "function" ? raw() : raw;
  if (value !== undefined) json.default = value;
  return json;
}

// ─── Shared object builder ───

function objectSchema(
  entries: Record<PropertyKey, unknown> | undefined,
  ctx: ConvertContext,
  convert: (node: unknown, ctx: ConvertContext) => JsonSchemaObject,
  isOptional: (node: unknown) => boolean,
  additionalProperties: unknown,
): JsonSchemaObject {
  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(entries ?? {})) {
    properties[key] = convert(value, ctx);
    if (!isOptional(value)) required.push(key);
  }

  const json: JsonSchemaObject = { type: "object", properties };
  if (required.length > 0) json.required = required;
  if (additionalProperties !== undefined) json.additionalProperties = additionalProperties;
  return json;
}

// ─── Entry points ───

/**
 * Convert a Zod schema (v3 or v4) to JSON Schema, reading its internal
 * representation directly so `zod` never has to be imported at runtime.
 */
export function zodToJsonSchema(schema: unknown): JsonSchemaObject {
  return convertZodNode(schema, newContext());
}

/**
 * Convert a Valibot schema to JSON Schema, reading its internal representation
 * directly so `valibot` never has to be imported at runtime.
 */
export function valibotToJsonSchema(schema: unknown): JsonSchemaObject {
  return convertValibotNode(schema, newContext());
}
