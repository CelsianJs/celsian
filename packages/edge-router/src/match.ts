import type { CompiledRoute, RouteEntry, RouteMatch } from "./types.js";

/**
 * Escape regex special characters in a string so it matches literally.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a route pattern into a regex for fast matching.
 * Supports :param segments and * wildcards.
 * Literal segments are escaped to prevent ReDoS via regex special chars.
 */
export function compileRoute(entry: RouteEntry): CompiledRoute {
  const paramNames: string[] = [];

  // Split pattern on :param and * tokens, escape literal segments, reassemble.
  // Tokenize: extract :param and * as special tokens, everything else is literal.
  const tokens: Array<{ type: "literal" | "param" | "wildcard"; value: string }> = [];
  const tokenRegex = /:([^/]+)|\*/g;
  let lastIndex = 0;
  let tokenMatch: RegExpExecArray | null;

  while ((tokenMatch = tokenRegex.exec(entry.pattern)) !== null) {
    // Literal text before this token
    if (tokenMatch.index > lastIndex) {
      tokens.push({ type: "literal", value: entry.pattern.slice(lastIndex, tokenMatch.index) });
    }
    if (tokenMatch[0] === "*") {
      tokens.push({ type: "wildcard", value: "*" });
    } else {
      tokens.push({ type: "param", value: tokenMatch[1] });
    }
    lastIndex = tokenMatch.index + tokenMatch[0].length;
  }

  // Trailing literal text
  if (lastIndex < entry.pattern.length) {
    tokens.push({ type: "literal", value: entry.pattern.slice(lastIndex) });
  }

  // Build regex string from tokens
  let regexStr = "";
  for (const token of tokens) {
    switch (token.type) {
      case "literal":
        regexStr += escapeRegex(token.value);
        break;
      case "param":
        paramNames.push(token.value);
        regexStr += "([^/]+)";
        break;
      case "wildcard":
        regexStr += "(.*)";
        break;
    }
  }

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
