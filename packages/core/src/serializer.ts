// @celsian/core — Pre-compiled JSON serializer from response schemas

/**
 * A pre-compiled serializer function that converts an object to a JSON string
 * faster than generic JSON.stringify by knowing the schema shape at compile time.
 */
export type FastSerializer = (data: unknown) => string;

/**
 * Compile a fast JSON serializer from a response schema definition.
 *
 * Supports Zod, TypeBox, and plain JSON Schema objects with `properties`.
 * Falls back to JSON.stringify for schemas it can't optimize.
 *
 * The compiled function iterates only known keys in a fixed order,
 * skipping JSON.stringify's generic key enumeration and type-detection overhead.
 */
export function compileSerializer(schema: unknown): FastSerializer | null {
  const properties = extractProperties(schema);
  if (!properties || properties.length === 0) {
    return null;
  }

  // Build a serializer that handles the known properties in order
  return buildObjectSerializer(properties);
}

interface PropertyInfo {
  key: string;
  type: string | null; // 'string' | 'number' | 'boolean' | 'array' | 'object' | null
  required: boolean;
  nested: PropertyInfo[] | null; // For nested objects
}

/**
 * Extract property definitions from various schema formats.
 * Supports: TypeBox (JSON Schema), Zod, Valibot, and plain JSON Schema.
 */
function extractProperties(schema: unknown): PropertyInfo[] | null {
  if (!schema || typeof schema !== "object") return null;

  const s = schema as Record<string, unknown>;

  // TypeBox / plain JSON Schema: { type: 'object', properties: { ... } }
  if (s.properties && typeof s.properties === "object") {
    const requiredSet = new Set(
      Array.isArray(s.required) ? (s.required as string[]) : [],
    );
    return extractJsonSchemaProperties(
      s.properties as Record<string, unknown>,
      requiredSet,
    );
  }

  // Zod: has .shape and ._def
  if (s.shape && typeof s.shape === "object" && s._def) {
    return extractZodProperties(s.shape as Record<string, unknown>);
  }

  // Zod: has ._def.shape (wrapped in effects/transforms)
  if (s._def && typeof s._def === "object") {
    const def = s._def as Record<string, unknown>;
    if (def.shape && typeof def.shape === "function") {
      try {
        const shape = (def.shape as () => Record<string, unknown>)();
        return extractZodProperties(shape);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function extractJsonSchemaProperties(
  properties: Record<string, unknown>,
  requiredSet: Set<string>,
): PropertyInfo[] {
  const result: PropertyInfo[] = [];

  for (const [key, def] of Object.entries(properties)) {
    if (!def || typeof def !== "object") continue;
    const d = def as Record<string, unknown>;
    const type = typeof d.type === "string" ? d.type : null;

    let nested: PropertyInfo[] | null = null;
    if (type === "object" && d.properties && typeof d.properties === "object") {
      const nestedRequired = new Set(
        Array.isArray(d.required) ? (d.required as string[]) : [],
      );
      nested = extractJsonSchemaProperties(
        d.properties as Record<string, unknown>,
        nestedRequired,
      );
    }

    result.push({
      key,
      type,
      required: requiredSet.has(key),
      nested,
    });
  }

  return result;
}

function extractZodProperties(shape: Record<string, unknown>): PropertyInfo[] {
  const result: PropertyInfo[] = [];

  for (const [key, def] of Object.entries(shape)) {
    if (!def || typeof def !== "object") continue;
    const d = def as Record<string, unknown>;

    // Detect Zod type from _def.typeName
    let type: string | null = null;
    let nested: PropertyInfo[] | null = null;
    const zodDef = d._def as Record<string, unknown> | undefined;

    if (zodDef?.typeName) {
      const tn = zodDef.typeName as string;
      if (tn === "ZodString") type = "string";
      else if (tn === "ZodNumber") type = "number";
      else if (tn === "ZodBoolean") type = "boolean";
      else if (tn === "ZodArray") type = "array";
      else if (tn === "ZodObject") {
        type = "object";
        if (d.shape && typeof d.shape === "object") {
          nested = extractZodProperties(d.shape as Record<string, unknown>);
        }
      }
    }

    // Zod marks optional with isOptional()
    let required = true;
    if (typeof d.isOptional === "function") {
      try {
        required = !(d as { isOptional(): boolean }).isOptional();
      } catch {
        // ignore
      }
    }

    result.push({ key, type, required, nested });
  }

  return result;
}

/**
 * Build a serializer function for an object with known properties.
 * The generated function avoids JSON.stringify's key enumeration by
 * iterating a fixed set of keys.
 */
function buildObjectSerializer(properties: PropertyInfo[]): FastSerializer {
  // For each property, generate the key prefix string once (e.g. `"name":`)
  const keyPrefixes = properties.map(
    (p) => JSON.stringify(p.key) + ":",
  );

  // Pre-build nested serializers for object-typed properties
  const nestedSerializers = properties.map((p) =>
    p.nested && p.nested.length > 0 ? buildObjectSerializer(p.nested) : null,
  );

  return function fastSerialize(data: unknown): string {
    if (data === null || data === undefined) return "null";
    if (typeof data !== "object") return JSON.stringify(data);

    const obj = data as Record<string, unknown>;
    let result = "{";
    let first = true;

    for (let i = 0; i < properties.length; i++) {
      const prop = properties[i]!;
      const value = obj[prop.key];

      // Skip undefined values (matches JSON.stringify behavior)
      if (value === undefined) continue;

      if (!first) result += ",";
      first = false;

      result += keyPrefixes[i];

      // Fast-path known types
      if (value === null) {
        result += "null";
      } else if (prop.type === "string" && typeof value === "string") {
        result += serializeString(value);
      } else if (prop.type === "number" && typeof value === "number") {
        // NaN and Infinity are not valid JSON — JSON.stringify outputs null for these
        result += Number.isFinite(value) ? value.toString() : "null";
      } else if (prop.type === "boolean" && typeof value === "boolean") {
        result += value ? "true" : "false";
      } else if (nestedSerializers[i] && typeof value === "object" && !Array.isArray(value)) {
        result += nestedSerializers[i]!(value);
      } else {
        // Fallback for arrays, mismatched types, or complex values
        result += JSON.stringify(value);
      }
    }

    result += "}";
    return result;
  };
}

/**
 * Serialize a string value with proper JSON escaping.
 * Faster than JSON.stringify for most strings because it avoids
 * creating a wrapper array/object.
 */
function serializeString(value: string): string {
  // Fast path: if no special chars, just wrap in quotes
  if (!needsEscape(value)) {
    return '"' + value + '"';
  }
  // Fallback to JSON.stringify for strings with special chars
  return JSON.stringify(value);
}

/**
 * Check if a string needs JSON escaping.
 * Special chars: \ " and control chars (< 0x20)
 */
function needsEscape(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 /* " */ || c === 0x5c /* \ */ || c < 0x20) {
      return true;
    }
  }
  return false;
}
