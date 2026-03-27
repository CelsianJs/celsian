import type { CompiledRoute, RouteEntry, RouteMatch } from "./types.js";

/**
 * Compile a route pattern into a regex for fast matching.
 * Supports :param segments and * wildcards.
 */
export function compileRoute(entry: RouteEntry): CompiledRoute {
  const paramNames: string[] = [];

  const regexStr = entry.pattern
    .replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    })
    .replace(/\*/g, "(.*)");

  return {
    entry,
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
    methods: new Set(entry.methods.map((m) => m.toUpperCase())),
  };
}

/**
 * Compile an array of route entries into compiled routes.
 */
export function compileRoutes(entries: RouteEntry[]): CompiledRoute[] {
  return entries.map(compileRoute);
}

/**
 * Match a pathname + method against compiled routes.
 * Returns the first matching route and extracted params, or null.
 */
export function matchRoute(routes: CompiledRoute[], pathname: string, method: string): RouteMatch | null {
  const upperMethod = method.toUpperCase();

  for (const route of routes) {
    if (!route.methods.has(upperMethod) && !route.methods.has("*")) continue;

    const match = pathname.match(route.regex);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });

    return { route, params };
  }

  return null;
}

/**
 * Apply a rewrite pattern, substituting :param references with matched values.
 */
export function applyRewrite(rewrite: string, params: Record<string, string>): string {
  return rewrite.replace(/:([^/]+)/g, (_, name) => params[name] ?? "");
}
