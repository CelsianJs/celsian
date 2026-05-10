// @celsian/core — Radix tree router with URL pattern matching

import { fromSchema } from "@celsian/schema";
import { compileSerializer } from "./serializer.js";
import type { InternalRoute, RouteHandler, RouteHooks, RouteMatch, RouteMethod } from "./types.js";

interface RadixNode {
  segment: string;
  children: Map<string, RadixNode>;
  paramChild: RadixNode | null;
  paramName: string | null;
  wildcardChild: RadixNode | null;
  wildcardName: string | null;
  routes: Map<RouteMethod, InternalRoute>;
}

function createNode(segment = ""): RadixNode {
  return {
    segment,
    children: new Map(),
    paramChild: null,
    paramName: null,
    wildcardChild: null,
    wildcardName: null,
    routes: new Map(),
  };
}

// Shared empty params object for static route matches (frozen to prevent mutation)
const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));

export class Router {
  private root = createNode();

  // O(1) fast path: fully static routes (no `:param` or `*wildcard` segments)
  private staticRoutes = new Map<string, Map<RouteMethod, InternalRoute>>();

  addRoute(
    method: RouteMethod,
    url: string,
    handler: RouteHandler,
    kind: "serverless" | "hot" | "task" = "serverless",
    schema?: InternalRoute["schema"],
    hooks?: Partial<RouteHooks>,
  ): void {
    const segments = splitPath(url);
    let node = this.root;
    let isStatic = true;

    for (const seg of segments) {
      if (seg.startsWith(":")) {
        isStatic = false;
        if (!node.paramChild) {
          node.paramChild = createNode(seg);
          node.paramName = seg.slice(1);
        }
        node = node.paramChild;
      } else if (seg.startsWith("*")) {
        isStatic = false;
        if (!node.wildcardChild) {
          node.wildcardChild = createNode(seg);
          node.wildcardName = seg.slice(1) || "wild";
        }
        node = node.wildcardChild;
        break;
      } else {
        let child = node.children.get(seg);
        if (!child) {
          child = createNode(seg);
          node.children.set(seg, child);
        }
        node = child;
      }
    }

    // Pre-compile response serializer from schema.response (if defined)
    // Uses the 200 status schema by default, falling back to the first defined status
    let serializer: InternalRoute["serializer"] = null;
    if (schema?.response) {
      const responseSchemas = schema.response as Record<number, unknown>;
      const targetSchema = responseSchemas[200] ?? Object.values(responseSchemas)[0];
      if (targetSchema) {
        serializer = compileSerializer(targetSchema);
      }
    }

    const validators = compileRequestValidators(schema);

    const route: InternalRoute = {
      method,
      url,
      handler,
      kind,
      schema,
      hooks: {
        onRequest: hooks?.onRequest ?? [],
        preHandler: hooks?.preHandler ?? [],
        preSerialization: hooks?.preSerialization ?? [],
        onSend: hooks?.onSend ?? [],
      },
      serializer,
      validators,
    };

    node.routes.set(method, route);

    // Populate the static fast-path map
    if (isStatic) {
      // Normalize the key: strip trailing slashes, use '/' for root
      const key = normalizePathname(url);
      let methodMap = this.staticRoutes.get(key);
      if (!methodMap) {
        methodMap = new Map();
        this.staticRoutes.set(key, methodMap);
      }
      methodMap.set(method, route);
    }
  }

  match(method: RouteMethod, pathname: string): RouteMatch | null {
    // Fast path: check static route map first (O(1), no split, no tree walk)
    const key = normalizePathname(pathname);
    const staticMethodMap = this.staticRoutes.get(key);
    if (staticMethodMap) {
      const route = staticMethodMap.get(method);
      if (route) {
        return {
          handler: route.handler,
          params: EMPTY_PARAMS,
          route,
        };
      }
      // Method not found in static map — but the path might also match a
      // param/wildcard route registered on the same tree branch, so fall through.
    }

    // Slow path: radix tree walk (handles params & wildcards)
    const segments = splitPath(pathname);
    const params: Record<string, string> = {};

    const result = this.matchNode(this.root, segments, 0, params, method);
    if (!result) return null;

    const route = result.routes.get(method);
    if (!route) return null;

    // `params` was freshly created above — no need to copy with `{ ...params }`
    return {
      handler: route.handler,
      params,
      route,
    };
  }

  private matchNode(
    node: RadixNode,
    segments: string[],
    index: number,
    params: Record<string, string>,
    method: RouteMethod,
  ): RadixNode | null {
    if (index >= segments.length) {
      return node.routes.has(method) ? node : null;
    }

    const seg = segments[index]!;

    // 1. Static match (highest priority)
    const staticChild = node.children.get(seg);
    if (staticChild) {
      const result = this.matchNode(staticChild, segments, index + 1, params, method);
      if (result) return result;
    }

    // 2. Parameter match
    if (node.paramChild && node.paramName) {
      params[node.paramName] = decodeURIComponent(seg);
      const result = this.matchNode(node.paramChild, segments, index + 1, params, method);
      if (result) return result;
      delete params[node.paramName];
    }

    // 3. Wildcard match (lowest priority, consumes rest)
    if (node.wildcardChild && node.wildcardName) {
      if (node.wildcardChild.routes.has(method)) {
        params[node.wildcardName] = decodeURIComponent(segments.slice(index).join("/"));
        return node.wildcardChild;
      }
    }

    return null;
  }

  /** Check if any method is registered for this exact path (for 405 detection).
   *  Excludes wildcard catch-all matches to avoid CORS OPTIONS routes
   *  turning all 404s into 405s. */
  hasPath(pathname: string): boolean {
    const key = normalizePathname(pathname);
    if (this.staticRoutes.has(key)) return true;

    const segments = splitPath(pathname);
    return this._hasPath(this.root, segments, 0);
  }

  private _hasPath(node: RadixNode, segments: string[], index: number): boolean {
    if (index >= segments.length) {
      return node.routes.size > 0;
    }
    const seg = segments[index]!;
    const staticChild = node.children.get(seg);
    if (staticChild && this._hasPath(staticChild, segments, index + 1)) return true;
    if (node.paramChild && this._hasPath(node.paramChild, segments, index + 1)) return true;
    // Intentionally exclude wildcardChild — a catch-all like OPTIONS /*path
    // should not cause non-existent paths to return 405 instead of 404
    return false;
  }

  getAllRoutes(): InternalRoute[] {
    const routes: InternalRoute[] = [];
    this.collectRoutes(this.root, routes);
    return routes;
  }

  private collectRoutes(node: RadixNode, routes: InternalRoute[]): void {
    for (const route of node.routes.values()) {
      routes.push(route);
    }
    for (const child of node.children.values()) {
      this.collectRoutes(child, routes);
    }
    if (node.paramChild) {
      this.collectRoutes(node.paramChild, routes);
    }
    if (node.wildcardChild) {
      this.collectRoutes(node.wildcardChild, routes);
    }
  }
}

function compileRequestValidators(schema: InternalRoute["schema"]): InternalRoute["validators"] {
  if (!schema) return null;

  const validators: NonNullable<InternalRoute["validators"]> = {};
  const body = tryCompileSchema(schema.body);
  const querystring = tryCompileSchema(schema.querystring);
  const params = tryCompileSchema(schema.params);
  if (body) validators.body = body;
  if (querystring) validators.querystring = querystring;
  if (params) validators.params = params;

  return validators.body || validators.querystring || validators.params ? validators : null;
}

function tryCompileSchema(schema: unknown): NonNullable<InternalRoute["validators"]>["body"] | null {
  if (!schema) return null;
  try {
    return fromSchema(schema);
  } catch {
    // Preserve backwards compatibility for type-only schema placeholders by
    // deferring unsupported-schema errors until an actual request validates.
    return null;
  }
}

// ─── Module-level helpers (avoids `this` overhead) ───

/** Split a URL path into segments, filtering out empty strings. */
function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Normalize a pathname for static-map keys: '/' for root, otherwise strip trailing slash. */
function normalizePathname(p: string): string {
  if (p === "/" || p === "") return "/";
  // Strip trailing slash for consistency (e.g. '/users/' -> '/users')
  return p.endsWith("/") ? p.slice(0, -1) : p;
}
