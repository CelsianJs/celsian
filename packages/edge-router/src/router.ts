import { corsHeaders, preflightResponse } from "./cors.js";
import { compileRoutes, matchRoute } from "./match.js";
import { proxyRequest } from "./proxy.js";
import type { CompiledRoute, EdgeRouterConfig } from "./types.js";
import { handleUpdateRoutes } from "./update-routes.js";

export { corsHeaders, isOriginAllowed, preflightResponse } from "./cors.js";
export { applyRewrite, compileRoute, compileRoutes, matchRoute } from "./match.js";
export { proxyRequest } from "./proxy.js";
export type { CompiledRoute, EdgeRouterConfig } from "./types.js";
export { handleUpdateRoutes } from "./update-routes.js";

const MAX_CACHE_SIZE = 100;

/**
 * FIFO cache for route match results.
 */
class RouteCache<K, V> {
  private map = new Map<K, V>();
  private keys: K[] = [];

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (!this.map.has(key)) {
      if (this.keys.length >= MAX_CACHE_SIZE) {
        const oldest = this.keys.shift()!;
        this.map.delete(oldest);
      }
      this.keys.push(key);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.keys = [];
  }
}

/**
 * Parse a hostname to extract the project ID.
 *
 * Supported formats:
 * - `<project>.celsian.app` → `project`
 * - `<branch>--<project>.preview.celsian.app` → `project:preview:branch`
 */
export function getProjectId(hostname: string): string | null {
  // Preview: {branch}--{project}.preview.celsian.app
  const previewMatch = hostname.match(/^(.+?)--(.+?)\.preview\.celsian\.app$/);
  if (previewMatch) {
    const [, branch, project] = previewMatch;
    return `${project}:preview:${branch}`;
  }

  // Production: {project}.celsian.app
  const prodMatch = hostname.match(/^(.+?)\.celsian\.app$/);
  if (prodMatch) {
    return prodMatch[1];
  }

  return null;
}

/**
 * Create a Cloudflare Worker fetch handler for the edge router.
 */
export function createEdgeRouter(config: EdgeRouterConfig) {
  let routes: CompiledRoute[] = compileRoutes(config.routes);
  const matchCache = new RouteCache<string, ReturnType<typeof matchRoute>>();

  return {
    async fetch(request: Request, env?: Record<string, string>): Promise<Response> {
      const url = new URL(request.url);

      // Health check
      if (url.pathname === "/__health") {
        return Response.json({
          ok: true,
          platform: "celsian",
          routes: routes.length,
        });
      }

      // Route update endpoint
      if (url.pathname === "/__routes" && request.method === "POST") {
        const apiKey = env?.ROUTER_API_KEY;
        const result = await handleUpdateRoutes(request, routes, apiKey);
        if (result.routes) {
          routes = result.routes;
          matchCache.clear();
        }
        return result.response;
      }

      // Route listing
      if (url.pathname === "/__routes" && request.method === "GET") {
        return Response.json({
          routes: routes.map((r) => ({
            pattern: r.entry.pattern,
            methods: Array.from(r.methods),
            origin: r.entry.origin,
          })),
        });
      }

      // CORS preflight
      if (config.cors && request.method === "OPTIONS") {
        const origin = request.headers.get("Origin") ?? "";
        return preflightResponse(origin, config.cors);
      }

      // Match route (with FIFO cache)
      const cacheKey = `${request.method}:${url.pathname}`;
      let match = matchCache.get(cacheKey);
      if (match === undefined) {
        match = matchRoute(routes, url.pathname, request.method);
        matchCache.set(cacheKey, match);
      }

      if (!match) {
        return Response.json({ error: "Not Found", path: url.pathname }, { status: 404 });
      }

      // Proxy to backend
      let response = await proxyRequest(request, match);

      // Add CORS headers if configured
      if (config.cors) {
        const origin = request.headers.get("Origin") ?? "";
        const cors = corsHeaders(origin, config.cors);
        if (Object.keys(cors).length > 0) {
          const newHeaders = new Headers(response.headers);
          for (const [key, value] of Object.entries(cors)) {
            newHeaders.set(key, value);
          }
          response = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        }
      }

      return response;
    },
  };
}
