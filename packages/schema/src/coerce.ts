// @celsian/schema — Type coercion for query strings and URL params

export function coerceString(value: string, targetType: "number"): number;
export function coerceString(value: string, targetType: "boolean"): boolean;
export function coerceString(value: string, targetType: "date"): Date;
export function coerceString(value: string, targetType: string): unknown;
export function coerceString(value: string, targetType: string): unknown {
  switch (targetType) {
    case "number": {
      const n = Number(value);
      if (Number.isNaN(n)) {
        throw new TypeError(`Cannot coerce "${value}" to number`);
      }
      return n;
    }
    case "boolean": {
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0" || value === "") return false;
      throw new TypeError(`Cannot coerce "${value}" to boolean`);
    }
    case "date": {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        throw new TypeError(`Cannot coerce "${value}" to Date`);
      }
      return d;
    }
    default:
      return value;
  }
}

export function coerceQueryParams(
  query: Record<string, string>,
  schema: Record<string, "string" | "number" | "boolean" | "date">,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    const targetType = schema[key];
    if (targetType && targetType !== "string") {
      result[key] = coerceString(value, targetType);
    } else {
      result[key] = value;
    }
  }
  return result;
}
