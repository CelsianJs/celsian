// @celsian/core -- A route's schemas, adapted once when the route is registered

import { fromSchema, type StandardSchema } from "@celsian/schema";
import { isStatusKeyedResponseMap } from "./response-schema.js";
import type { InternalRoute } from "./types.js";

type RouteSchema = NonNullable<InternalRoute["schema"]>;

/** One schema as the route declared it, with the adapter built from it. */
interface Adapted {
  raw: unknown;
  adapter: StandardSchema;
}

/**
 * The adapters for a route's `schema`, built at registration.
 *
 * `fromSchema()` used to run on every request for every part of the schema,
 * building a new adapter object each time out of a schema that never changes.
 */
export interface RouteValidators {
  body: Adapted | undefined;
  querystring: Adapted | undefined;
  params: Adapted | undefined;
  /** Response schemas, keyed by the schema object the route declared. */
  responses: Map<unknown, StandardSchema>;
}

/** Key under which a route carries its {@link RouteValidators}. */
export const ROUTE_VALIDATORS = Symbol("celsian.routeValidators");

/** A route as the router builds it, with its adapters attached. */
export interface RouteWithValidators {
  [ROUTE_VALIDATORS]?: RouteValidators;
}

/**
 * Adapt `raw`, or return `undefined` when it cannot be adapted.
 *
 * An unsupported schema must not fail registration: it never did. It is left
 * unadapted here and `validatorFor` adapts it per request, which throws the
 * same SchemaError, for that request, as before.
 */
function adapt(raw: unknown): Adapted | undefined {
  if (!raw) return undefined;
  try {
    return { raw, adapter: fromSchema(raw) };
  } catch {
    return undefined;
  }
}

/** Build the adapters for a route's `schema`. */
export function compileRouteValidators(schema: RouteSchema): RouteValidators {
  const responses = new Map<unknown, StandardSchema>();
  const response = schema.response;
  if (typeof response === "object" && response !== null) {
    // Either one bare schema, or a map of them by status code (plus `default`).
    const declared = isStatusKeyedResponseMap(response) ? Object.values(response) : [response];
    for (const raw of declared) {
      const adapted = adapt(raw);
      if (adapted !== undefined) responses.set(raw, adapted.adapter);
    }
  }
  return {
    body: adapt(schema.body),
    querystring: adapt(schema.querystring),
    params: adapt(schema.params),
    responses,
  };
}

/**
 * The adapter for `raw`: the one built at registration when `raw` is still the
 * schema the route declared, a fresh one otherwise (the route's `schema` was
 * changed afterwards, or it could not be adapted at registration).
 */
export function validatorFor(adapted: Adapted | undefined, raw: unknown): StandardSchema {
  return adapted !== undefined && adapted.raw === raw ? adapted.adapter : fromSchema(raw);
}

/** {@link validatorFor} for a response schema. */
export function responseValidatorFor(validators: RouteValidators | undefined, raw: unknown): StandardSchema {
  return validators?.responses.get(raw) ?? fromSchema(raw);
}
