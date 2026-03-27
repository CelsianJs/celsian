import { compileRoutes } from "./match.js";
import type { CompiledRoute, RouteEntry, UpdateRoutesResult } from "./types.js";

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
