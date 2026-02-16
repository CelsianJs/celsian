// @celsian/core — OpenAPI 3.1 documentation plugin for REST routes

import type { PluginFunction, InternalRoute } from '../types.js';

export interface OpenAPIOptions {
  title?: string;
  version?: string;
  description?: string;
  servers?: Array<{ url: string; description?: string }>;
  /** Path to serve the JSON spec (default: '/docs/openapi.json') */
  jsonPath?: string;
  /** Path to serve the Swagger UI (default: '/docs') */
  uiPath?: string;
}

interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
}

// ─── Schema Helpers ───

/**
 * Extract a JSON Schema-compatible object from a schema definition.
 * Supports TypeBox schemas (which have `type` and `properties` directly),
 * plain JSON Schema objects, and objects with a `toJsonSchema()` method.
 */
function extractJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (schema == null || typeof schema !== 'object') return null;

  const s = schema as Record<string, unknown>;

  // If it has a toJsonSchema method (e.g. @celsian/schema wrappers)
  if (typeof s.toJsonSchema === 'function') {
    return s.toJsonSchema() as Record<string, unknown>;
  }

  // TypeBox / plain JSON Schema — has `type` at the top level
  if ('type' in s) {
    return s;
  }

  // If it has `properties`, treat it as an object schema missing `type`
  if ('properties' in s) {
    return { type: 'object', ...s };
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
    in: 'path',
    required: required.includes(name) || true, // path params are always required
    schema: prop ?? { type: 'string' },
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
    in: 'query',
    required: required.includes(name),
    schema: prop ?? { type: 'string' },
  }));
}

/**
 * Convert CelsianJS route path (/users/:id) to OpenAPI path (/users/{id}).
 */
function toOpenAPIPath(url: string): string {
  return url.replace(/:([^/]+)/g, '{$1}').replace(/\*([^/]*)/g, '{$1}');
}

/**
 * Derive a tag from a URL path (first meaningful segment).
 */
function deriveTag(url: string): string {
  const segments = url.split('/').filter(Boolean);
  if (segments.length === 0) return 'default';
  const first = segments[0]!;
  // Skip param/wildcard segments
  if (first.startsWith(':') || first.startsWith('*') || first.startsWith('{')) {
    return 'default';
  }
  return first;
}

/**
 * Build an operation ID from method + url.
 */
function buildOperationId(method: string, url: string): string {
  const parts = url
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(':')) return `By${capitalize(seg.slice(1))}`;
      if (seg.startsWith('*')) return 'Wildcard';
      return capitalize(seg);
    });
  return method.toLowerCase() + parts.join('');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Spec Generator ───

function generateSpec(
  routes: InternalRoute[],
  options: OpenAPIOptions,
): OpenAPISpec {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const openAPIPath = toOpenAPIPath(route.url);
    const method = route.method.toLowerCase();

    const operation: Record<string, unknown> = {
      operationId: buildOperationId(route.method, route.url),
      tags: [deriveTag(route.url)],
      summary: `${route.method} ${route.url}`,
    };

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
          in: 'path',
          required: true,
          schema: { type: 'string' },
        });
      }
    }

    if (route.schema?.querystring) {
      parameters.push(...schemaToQueryParams(route.schema.querystring));
    }

    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    // Request body
    if (route.schema?.body) {
      const bodySchema = extractJsonSchema(route.schema.body);
      if (bodySchema) {
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: bodySchema },
          },
        };
      }
    }

    // Responses
    if (route.schema?.response) {
      const responses: Record<string, unknown> = {};
      for (const [code, responseSchema] of Object.entries(route.schema.response)) {
        const json = extractJsonSchema(responseSchema);
        if (json) {
          responses[String(code)] = {
            description: `Response ${code}`,
            content: {
              'application/json': { schema: json },
            },
          };
        } else {
          responses[String(code)] = { description: `Response ${code}` };
        }
      }
      operation.responses = responses;
    } else {
      operation.responses = {
        '200': { description: 'Successful response' },
      };
    }

    if (!paths[openAPIPath]) {
      paths[openAPIPath] = {};
    }
    (paths[openAPIPath] as Record<string, unknown>)[method] = operation;
  }

  const spec: OpenAPISpec = {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'CelsianJS API',
      version: options.version ?? '1.0.0',
      ...(options.description ? { description: options.description } : {}),
    },
    paths,
  };

  if (options.servers && options.servers.length > 0) {
    spec.servers = options.servers;
  }

  return spec;
}

// ─── Swagger UI HTML ───

function swaggerHTML(jsonPath: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${jsonPath}',
      dom_id: '#swagger-ui',
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset,
      ],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`;
}

// ─── Plugin ───

export function openapi(options: OpenAPIOptions = {}): PluginFunction {
  const jsonPath = options.jsonPath ?? '/docs/openapi.json';
  const uiPath = options.uiPath ?? '/docs';

  return function openapiPlugin(app) {
    // Serve the OpenAPI JSON spec
    app.route({
      method: 'GET',
      url: jsonPath,
      handler(_request, reply) {
        // Lazily generate the spec at request time so all routes are registered
        const routes = app.getRoutes().filter(
          (r) => r.url !== jsonPath && r.url !== uiPath,
        );
        const spec = generateSpec(routes, options);
        return reply.header('content-type', 'application/json; charset=utf-8').send(JSON.stringify(spec, null, 2));
      },
    });

    // Serve the Swagger UI HTML page
    app.route({
      method: 'GET',
      url: uiPath,
      handler(_request, reply) {
        const title = options.title ?? 'CelsianJS API';
        return reply.html(swaggerHTML(jsonPath, title));
      },
    });
  };
}
