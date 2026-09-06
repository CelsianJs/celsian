// @celsian/core, OpenAPI 3.1 documentation plugin for REST routes

import { fromSchema, type StandardSchema } from "@celsian/schema";
import { isStatusKeyedResponseMap } from "../response-schema.js";
import type { InternalRoute, PluginFunction } from "../types.js";

export interface OpenAPIOptions {
  title?: string;
  version?: string;
  description?: string;
  servers?: Array<{ url: string; description?: string }>;
  /** Available auth schemes. Declare requirements on each route's openapi.security. */
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
  /** Path to serve the JSON spec (default: '/docs/openapi.json') */
  jsonPath?: string;
  /** Path to serve the Swagger UI (default: '/docs') */
  uiPath?: string;
  /**
   * Serve the Swagger UI page (default: true). `/docs` is unauthenticated and
   * is visited by logged-in developers, so gate it behind auth in production,
   * or set this to false and keep only the JSON spec.
   */
  ui?: boolean;
  /**
   * Swagger UI assets to load from jsdelivr. Pinned by exact version with
   * subresource-integrity hashes: an unpinned CDN URL means whatever that path
   * serves tomorrow runs on your developers' authenticated browsers.
   * Override both fields together when bumping the version.
   */
  swaggerUi?: SwaggerUIAssets;
}

/** HTTP and API-key authentication schemes supported by Swagger UI. */
export type OpenAPISecurityScheme =
  | { type: "http"; scheme: string; bearerFormat?: string; description?: string }
  | { type: "apiKey"; name: string; in: "header" | "query" | "cookie"; description?: string };

/** Pinned Swagger UI assets: exact version plus subresource-integrity hashes. */
export interface SwaggerUIAssets {
  version: string;
  jsIntegrity: string;
  cssIntegrity: string;
}

/** Pinned Swagger UI release with verified SRI hashes (sha384). */
const SWAGGER_UI: SwaggerUIAssets = {
  version: "5.17.14",
  jsIntegrity: "sha384-wmyclcVGX/WhUkdkATwhaK1X1JtiNrr2EoYJ+diV3vj4v6OC5yCeSu+yW13SYJep",
  cssIntegrity: "sha384-wxLW6kwyHktdDGr6Pv1zgm/VGJh99lfUbzSn6HNHBENZlCN7W602k9VkGdxuFvPn",
};

interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: { securitySchemes: Record<string, OpenAPISecurityScheme> };
}

// ─── Schema Helpers ───

/**
 * Extract a JSON Schema-compatible object from a schema definition.
 * Supports TypeBox schemas (which have `type` and `properties` directly),
 * plain JSON Schema objects, objects with a `toJsonSchema()` method,
 * and Zod/Valibot schemas (auto-detected via @celsian/schema adapters).
 */
function extractJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (schema == null || typeof schema !== "object") return null;

  const s = schema as Record<string, unknown>;

  // If it has a toJsonSchema method (e.g. @celsian/schema wrappers)
  if (typeof s.toJsonSchema === "function") {
    return s.toJsonSchema() as Record<string, unknown>;
  }

  // Try the adapters BEFORE any structural guess. `fromSchema` recognizes
  // TypeBox (by its Kind symbol), Zod, Valibot, and plain JSON Schema object
  // schemas, and converts each one properly.
  //
  // Order matters: a `"type" in s` shortcut used to run first, and every
  // Valibot schema natively carries `type: "object"`, so Valibot routes shipped
  // their raw internal AST (`kind`, `expects`, `entries`, `~standard`) into the
  // document verbatim. That is not JSON Schema, and Swagger UI rendered it as
  // an empty model.
  try {
    const wrapped: StandardSchema = fromSchema(s);
    return wrapped.toJsonSchema() as Record<string, unknown>;
  } catch {
    // Not a recognized schema library, fall through to the structural forms.
  }

  // Plain JSON Schema fragment, has `type` at the top level (e.g. { type: "string" }).
  if ("type" in s) {
    return s;
  }

  // If it has `properties`, treat it as an object schema missing `type`
  if ("properties" in s) {
    return { type: "object", ...s };
  }

  return null;
}

/**
 * Convert a params schema into OpenAPI path parameter objects.
 * Handles both JSON Schema `properties` and simple key-value shapes.
 */
function schemaToPathParams(schema: unknown): Array<Record<string, unknown>> {
  const json = extractJsonSchema(schema);
  if (!json) return [];

  const properties = json.properties as Record<string, unknown> | undefined;
  if (!properties) return [];

  const required = Array.isArray(json.required) ? (json.required as string[]) : [];

  return Object.entries(properties).map(([name, prop]) => ({
    name,
    in: "path",
    required: required.includes(name) || true, // path params are always required
    schema: prop ?? { type: "string" },
  }));
}

/**
 * Convert a querystring schema into OpenAPI query parameter objects.
 */
function schemaToQueryParams(schema: unknown): Array<Record<string, unknown>> {
  const json = extractJsonSchema(schema);
  if (!json) return [];

  const properties = json.properties as Record<string, unknown> | undefined;
  if (!properties) return [];

  const required = Array.isArray(json.required) ? (json.required as string[]) : [];

  return Object.entries(properties).map(([name, prop]) => ({
    name,
    in: "query",
    required: required.includes(name),
    schema: prop ?? { type: "string" },
  }));
}

/**
 * Convert CelsianJS route path (/users/:id) to OpenAPI path (/users/{id}).
 */
function toOpenAPIPath(url: string): string {
  return url.replace(/:([^/]+)/g, "{$1}").replace(/\*([^/]*)/g, "{$1}");
}

/**
 * Derive a tag from a URL path (first meaningful segment).
 */
function deriveTag(url: string): string {
  const segments = url.split("/").filter(Boolean);
  if (segments.length === 0) return "default";
  const first = segments[0]!;
  // Skip param/wildcard segments
  if (first.startsWith(":") || first.startsWith("*") || first.startsWith("{")) {
    return "default";
  }
  return first;
}

/**
 * Build an operation ID from method + url.
 */
function buildOperationId(method: string, url: string): string {
  const parts = url
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(":")) return `By${capitalize(seg.slice(1))}`;
      if (seg.startsWith("*")) return "Wildcard";
      return capitalize(seg);
    });
  return method.toLowerCase() + parts.join("");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Build one OpenAPI response object for `code` from a (possibly unusable) schema. */
function responseObject(description: string, responseSchema: unknown): Record<string, unknown> {
  const json = extractJsonSchema(responseSchema);
  if (!json) return { description };
  return {
    description,
    content: {
      "application/json": { schema: json },
    },
  };
}

/**
 * Turn a route's `schema.response` into the OpenAPI `responses` object.
 *
 * `schema.response` has two accepted spellings (see `resolveResponseSchema` in
 * `response-schema.ts`): the status-keyed map `{ 200: schema }` and a bare
 * schema applied to 2xx. This used to iterate `Object.entries()` over whichever
 * one it got, so a bare Zod schema enumerated the Zod INSTANCE'S OWN METHODS as
 * status codes and emitted ~29 responses called `spa`, `_def`, `parse`,
 * `safeParse`, `refine`, and so on. That is not a valid OpenAPI document.
 *
 * `isStatusKeyedResponseMap` is the same guard the runtime validator uses, so
 * the document and the enforcement can no longer disagree about which spelling
 * a route used.
 */
function buildResponses(response: unknown): Record<string, unknown> {
  const fallback: Record<string, unknown> = { "200": { description: "Successful response" } };
  if (response == null || typeof response !== "object") return fallback;

  if (!isStatusKeyedResponseMap(response)) {
    return { "200": responseObject("Successful response", response) };
  }

  const responses: Record<string, unknown> = {};
  for (const [code, responseSchema] of Object.entries(response)) {
    responses[code] = responseObject(`Response ${code}`, responseSchema);
  }
  // An empty map documents nothing; keep the generic 200 rather than emitting
  // an operation with no responses at all.
  return Object.keys(responses).length > 0 ? responses : fallback;
}

// ─── Spec Generator ───

/**
 * OpenAPI requires unique (in, name) pairs. Later explicit metadata overrides
 * inferred fields (and earlier explicit entries), retaining unspecified fields.
 * Schemas are replaced as a whole, not combined into incompatible constraints.
 */
function mergeParameters(parameters: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const parameter of parameters) {
    const key = JSON.stringify([parameter.in, parameter.name]);
    merged.set(key, {
      ...merged.get(key),
      ...parameter,
      // Required by OpenAPI even when documentation explicitly says false.
      ...(parameter.in === "path" ? { required: true } : {}),
    });
  }
  return [...merged.values()];
}

function generateSpec(routes: InternalRoute[], options: OpenAPIOptions): OpenAPISpec {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const openAPIPath = toOpenAPIPath(route.url);
    const method = route.method.toLowerCase();

    const operation: Record<string, unknown> = {
      operationId: buildOperationId(route.method, route.url),
      tags: [deriveTag(route.url)],
      summary: `${route.method} ${route.url}`,
    };
    if (route.openapi?.description !== undefined) operation.description = route.openapi.description;
    if (route.openapi?.security !== undefined) operation.security = route.openapi.security;

    // Parameters (path + query)
    const parameters: Array<Record<string, unknown>> = [];

    if (route.schema?.params) {
      parameters.push(...schemaToPathParams(route.schema.params));
    } else {
      // Auto-detect path params from the URL pattern
      const paramMatches = route.url.matchAll(/:([^/]+)/g);
      for (const m of paramMatches) {
        parameters.push({
          name: m[1],
          in: "path",
          required: true,
          schema: { type: "string" },
        });
      }
    }

    if (route.schema?.querystring) {
      parameters.push(...schemaToQueryParams(route.schema.querystring));
    }

    if (route.openapi?.parameters) {
      parameters.push(...route.openapi.parameters);
    }

    if (parameters.length > 0) {
      operation.parameters = mergeParameters(parameters);
    }

    // Request body
    if (route.schema?.body) {
      const bodySchema = extractJsonSchema(route.schema.body);
      if (bodySchema) {
        operation.requestBody = {
          required: true,
          content: {
            "application/json": { schema: bodySchema },
          },
        };
      }
    }

    // Responses
    operation.responses = buildResponses(route.schema?.response);

    if (!paths[openAPIPath]) {
      paths[openAPIPath] = {};
    }
    (paths[openAPIPath] as Record<string, unknown>)[method] = operation;
  }

  const spec: OpenAPISpec = {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "CelsianJS API",
      version: options.version ?? "1.0.0",
      ...(options.description ? { description: options.description } : {}),
    },
    paths,
  };

  if (options.servers && options.servers.length > 0) {
    spec.servers = options.servers;
  }
  if (options.securitySchemes && Object.keys(options.securitySchemes).length > 0) {
    spec.components = { securitySchemes: options.securitySchemes };
  }

  return spec;
}

// ─── Swagger UI HTML ───

/** Escape a string for safe interpolation into HTML content and attributes. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function swaggerHTML(jsonPath: string, title: string, assets: SwaggerUIAssets): string {
  const safeTitle = escapeHtml(title);
  const safeJsonPath = escapeHtml(jsonPath);
  const base = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${encodeURIComponent(assets.version)}`;
  // Per-response nonce so the bootstrap script runs without script-src
  // 'unsafe-inline'; the CDN bundle is covered by SRI instead.
  const nonce = crypto.randomUUID().replace(/-/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; img-src 'self' data:; script-src 'nonce-${nonce}' cdn.jsdelivr.net; style-src cdn.jsdelivr.net 'unsafe-inline';" />
  <title>${safeTitle} API Docs</title>
  <link rel="stylesheet" href="${base}/swagger-ui.css" integrity="${assets.cssIntegrity}" crossorigin="anonymous" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${base}/swagger-ui-bundle.js" integrity="${assets.jsIntegrity}" crossorigin="anonymous"></script>
  <script nonce="${nonce}">
    SwaggerUIBundle({
      url: '${safeJsonPath}',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`;
}

// ─── Plugin ───

export function openapi(options: OpenAPIOptions = {}): PluginFunction {
  const jsonPath = options.jsonPath ?? "/docs/openapi.json";
  const uiPath = options.uiPath ?? "/docs";

  return function openapiPlugin(app) {
    // Serve the OpenAPI JSON spec
    app.route({
      method: "GET",
      url: jsonPath,
      handler(_request, reply) {
        // Lazily generate the spec at request time so all routes are registered
        const routes = app.getRoutes().filter((r) => r.url !== jsonPath && r.url !== uiPath);
        const spec = generateSpec(routes, options);
        return reply.header("content-type", "application/json; charset=utf-8").send(JSON.stringify(spec, null, 2));
      },
    });

    // Serve the Swagger UI HTML page
    if (options.ui === false) return;
    const assets = options.swaggerUi ?? SWAGGER_UI;
    app.route({
      method: "GET",
      url: uiPath,
      handler(_request, reply) {
        const title = options.title ?? "CelsianJS API";
        return reply.html(swaggerHTML(jsonPath, title, assets));
      },
    });
  };
}
