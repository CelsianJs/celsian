import { compileRoutes } from "./match.js";
import { isInternalUrl } from "./proxy.js";
import type { CompiledRoute, RouteEntry, UpdateRoutesResult } from "./types.js";

const VALID_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MAX_PATTERN_LENGTH = 500;

/**
 * Validate a single route entry. Returns an error message string or null if valid.
 */
function validateRouteEntry(route: RouteEntry): string | null {
  // pattern must be a string starting with /
  if (typeof route.pattern !== "string") {
    return "Route pattern must be a string";
  }
  if (!route.pattern.startsWith("/")) {
    return `Route pattern must start with "/", got "${route.pattern}"`;
  }
  if (route.pattern.length > MAX_PATTERN_LENGTH) {
    return `Route pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`;
  }

  // methods must be an array of valid HTTP methods
  if (!Array.isArray(route.methods)) {
    return "Route methods must be an array";
  }
  for (const method of route.methods) {
    if (typeof method !== "string" || !VALID_HTTP_METHODS.has(method.toUpperCase())) {
      return `Invalid HTTP method: "${method}". Allowed: ${Array.from(VALID_HTTP_METHODS).join(", ")}`;
    }
  }

  // origin must be a valid URL with http(s) protocol
  if (typeof route.origin !== "string") {
    return "Route origin must be a string";
  }
  let originUrl: URL;
  try {
    originUrl = new URL(route.origin);
  } catch {
    return `Route origin is not a valid URL: "${route.origin}"`;
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    return `Route origin must use http or https protocol, got "${originUrl.protocol}"`;
  }

  // Reject internal/private origins (SSRF protection)
  if (isInternalUrl(originUrl)) {
    return `Route origin must not be an internal address: "${route.origin}"`;
  }

  return null;
}

/**
 * Handle a POST to /__routes — updates the routing table at runtime.
 *
 * Expects JSON body: { routes: RouteEntry[] }
 * Optionally protected by an API key via the `apiKey` parameter.
 */
export async function handleUpdateRoutes(
  request: Request,
  _currentRoutes: CompiledRoute[],
  apiKey?: string,
): Promise<{ response: Response; routes?: CompiledRoute[] }> {
  // Verify API key if configured
  if (apiKey) {
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.replace(/^Bearer\s+/, "");
    if (token !== apiKey) {
      return {
        response: Response.json({ success: false, error: "Unauthorized", routeCount: 0 } satisfies UpdateRoutesResult, {
          status: 401,
        }),
      };
    }
  }

  try {
    const body = (await request.json()) as { routes?: RouteEntry[] };

    if (!body.routes || !Array.isArray(body.routes)) {
      return {
        response: Response.json(
          { success: false, error: "Missing routes array", routeCount: 0 } satisfies UpdateRoutesResult,
          { status: 400 },
        ),
      };
    }

    // Validate each route entry
    for (const route of body.routes) {
      if (!route.pattern || !route.methods || !route.origin) {
        return {
          response: Response.json(
            {
              success: false,
              error: "Each route must have pattern, methods, and origin",
              routeCount: 0,
            } satisfies UpdateRoutesResult,
            { status: 400 },
          ),
        };
      }

      const validationError = validateRouteEntry(route);
      if (validationError) {
        return {
          response: Response.json(
            {
              success: false,
              error: validationError,
              routeCount: 0,
            } satisfies UpdateRoutesResult,
            { status: 400 },
          ),
        };
      }
    }

    const compiled = compileRoutes(body.routes);

    return {
      response: Response.json({ success: true, routeCount: compiled.length } satisfies UpdateRoutesResult),
      routes: compiled,
    };
  } catch {
    return {
      response: Response.json(
        { success: false, error: "Invalid JSON body", routeCount: 0 } satisfies UpdateRoutesResult,
        { status: 400 },
      ),
    };
  }
}
