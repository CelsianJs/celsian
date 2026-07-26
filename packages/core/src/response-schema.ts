// @celsian/core, Resolve a route's `schema.response` for a given status code

import type { ResponseSchemaMap, RouteResponseSchema } from "./types.js";

/** Lowest and highest status codes that may key a response-schema map. */
const MIN_STATUS = 100;
const MAX_STATUS = 599;

/** True if `key` is a canonical integer status code string, e.g. "200". */
function isStatusKey(key: string): boolean {
  if (!/^[1-5]\d\d$/.test(key)) return false;
  const code = Number(key);
  return code >= MIN_STATUS && code <= MAX_STATUS;
}

/**
 * Distinguish the status-keyed form, `{ 200: schema, default: schema }`, from a
 * bare schema passed directly as `schema.response`.
 *
 * A status map's own enumerable keys are all status codes or `default`. Every
 * schema library carries non-numeric own keys instead: Zod has `_def` / `def`,
 * TypeBox has `type` / `properties` (plus its `Symbol.for('TypeBox.Kind')`),
 * Valibot has `kind` / `type` / `~standard`, and Celsian's own `StandardSchema`
 * adapters have `validate` / `toJsonSchema`. So the two forms never collide.
 *
 * An object with no own keys counts as an (empty) map, which validates nothing.
 * That is the same no-op it produced before, and it is the only shape where
 * guessing either way is harmless.
 */
export function isStatusKeyedResponseMap(value: object): value is ResponseSchemaMap {
  if (Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return true;
  return keys.every((key) => key === "default" || isStatusKey(key));
}

/**
 * Pick the schema that applies to `status`, or `undefined` when none does.
 *
 * Two accepted spellings:
 *
 * - `{ 200: schema, default: schema }`, exact status wins, then `default`.
 * - `schema`, a bare schema, applied to every 2xx response.
 *
 * The bare form is the spelling that mirrors `schema.body` and
 * `schema.querystring`, and it used to be ignored entirely: a route whose
 * response schema forbade extra keys happily returned them with a 200. A safety
 * feature that no-ops on its most natural spelling is worse than not having it.
 *
 * A bare schema is scoped to 2xx deliberately, NOT treated as `default`. A
 * `default` entry also covers 4xx/5xx, so applying a success-shaped schema
 * there would turn every 404 and every validation error into a 500 for failing
 * to look like the success payload.
 *
 * `Object.hasOwn` is not optional here. `schemas[status] ?? schemas.default`
 * reads `default` off the prototype chain too, and Zod schemas carry a bound
 * `.default()` METHOD. Passing a bare Zod schema in the map position therefore
 * handed a function to the schema adapter, which threw
 * `SchemaError: Unsupported schema: received a function (bound default)` and
 * 500'd the request. That was a live 500 in `docs/migration-from-fastify.md`.
 */
export function resolveResponseSchema(response: RouteResponseSchema, status: number): unknown {
  if (typeof response !== "object" || response === null) return undefined;

  if (isStatusKeyedResponseMap(response)) {
    const map = response as Record<string, unknown>;
    const key = String(status);
    if (Object.hasOwn(map, key)) {
      const exact = map[key];
      if (exact !== undefined && exact !== null) return exact;
    }
    if (Object.hasOwn(map, "default")) {
      const fallback = map.default;
      if (fallback !== undefined && fallback !== null) return fallback;
    }
    return undefined;
  }

  // Bare schema: success responses only.
  return status >= 200 && status < 300 ? response : undefined;
}
