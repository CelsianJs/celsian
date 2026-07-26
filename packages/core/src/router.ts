// @celsian/core, Radix tree router with URL pattern matching

import { CelsianError, HttpError } from "./errors.js";
import type { InternalRoute, RouteHandler, RouteHooks, RouteMatch, RouteMethod } from "./types.js";

/** Options controlling how the router normalizes and validates request paths. */
export interface RouterOptions {
  /**
   * Treat `/users/` as `/users` (default: true, matching pre-0.6.0 behavior).
   * Every other form of path aliasing (`//users`, `/./users`, `/users//`) is
   * rejected unconditionally so an upstream ACL on `= /admin` cannot be walked
   * around with an equivalent-but-different path.
   */
  ignoreTrailingSlash?: boolean;
  /**
   * Reject route params that decode to a value containing `/`, `\` or NUL
   * (default: false). `%2F` inside a single segment decodes back into a slash,
   * which is how "one segment" params turn into traversal payloads.
   */
  strictParams?: boolean;
}

// Extra fields the router now returns. Belongs in types.ts (owned elsewhere).
declare module "./types.js" {
  interface RouteMatch {
    /** Route params exactly as they appeared in the URL, before percent-decoding. */
    rawParams: Record<string, string>;
  }
}

/**
 * Decode a route param/wildcard segment, converting malformed percent-encoding
 * (e.g. "%ZZ") into a 400 HttpError instead of an uncaught URIError.
 */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new HttpError(400, "Malformed URI in path", { code: "MALFORMED_URI" });
  }
}

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

  private readonly ignoreTrailingSlash: boolean;
  private readonly strictParams: boolean;

  constructor(options: RouterOptions = {}) {
    this.ignoreTrailingSlash = options.ignoreTrailingSlash !== false;
    this.strictParams = options.strictParams === true;
  }

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
        const name = seg.slice(1);
        if (!node.paramChild) {
          node.paramChild = createNode(seg);
          node.paramName = name;
        } else if (node.paramName !== name) {
          // A node holds exactly one param child, so two sibling routes with
          // different param names at the same position would both populate the
          // FIRST registered name and leave the second undefined at runtime.
          const existing = findFirstRouteUrl(node.paramChild) ?? `:${node.paramName}`;
          throw new CelsianError(
            `Conflicting param names at the same path position: "${url}" declares ":${name}" where "${existing}" already declares ":${node.paramName}". ` +
              `Rename one so both routes use ":${node.paramName}".`,
          );
        }
        node = node.paramChild;
      } else if (seg.startsWith("*")) {
        isStatic = false;
        if (!node.wildcardChild) {
          node.wildcardChild = createNode(seg);
          node.wildcardName = seg.slice(1) || "*";
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
    };

    const duplicate = node.routes.get(method);
    if (duplicate) {
      throw new CelsianError(
        `Duplicate route: ${method} "${url}" is already registered as ${method} "${duplicate.url}". ` +
          `Remove one registration, the second would silently replace the first.`,
      );
    }
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
    // Canonicalize once. Aliased forms ('//admin', '/./admin', '/admin//') are
    // 404s, not alternate spellings of a route an upstream gateway allow-listed.
    const canonical = canonicalizePath(pathname, this.ignoreTrailingSlash);
    if (canonical === null) return null;

    // Fast path: check static route map first (O(1), no split, no tree walk)
    const staticMethodMap = this.staticRoutes.get(canonical);
    if (staticMethodMap) {
      const route = staticMethodMap.get(method);
      if (route) {
        return {
          handler: route.handler,
          params: EMPTY_PARAMS,
          rawParams: EMPTY_PARAMS,
          route,
        };
      }
      // Method not found in static map, but the path might also match a
      // param/wildcard route registered on the same tree branch, so fall through.
    }

    // Slow path: radix tree walk (handles params & wildcards)
    const segments = splitPath(canonical);
    const params: Record<string, string> = {};
    const rawParams: Record<string, string> = {};

    const result = this.matchNode(this.root, segments, 0, params, rawParams, method);
    if (!result) return null;

    const route = result.routes.get(method);
    if (!route) return null;

    // `params` was freshly created above, no need to copy with `{ ...params }`
    return {
      handler: route.handler,
      params,
      rawParams,
      route,
    };
  }

  /**
   * Decode a matched segment, applying `strictParams` when enabled. `%2F`
   * decodes back into `/`, so a single-segment param can carry a path; without
   * strictParams that value is passed through unchanged (documented behavior,
   * and it also differs per runtime: API Gateway REST pre-decodes the path).
   */
  private decodeParam(seg: string): string {
    const decoded = decodeSegment(seg);
    if (this.strictParams && /[/\\\0]/.test(decoded)) {
      throw new HttpError(400, "Path parameter contains an illegal separator", {
        code: "INVALID_PATH_PARAM",
      });
    }
    return decoded;
  }

  private matchNode(
    node: RadixNode,
    segments: string[],
    index: number,
    params: Record<string, string>,
    rawParams: Record<string, string>,
    method: RouteMethod,
  ): RadixNode | null {
    if (index >= segments.length) {
      return node.routes.has(method) ? node : null;
    }

    const seg = segments[index]!;

    // 1. Static match (highest priority)
    const staticChild = node.children.get(seg);
    if (staticChild) {
      const result = this.matchNode(staticChild, segments, index + 1, params, rawParams, method);
      if (result) return result;
    }

    // 2. Parameter match
    if (node.paramChild && node.paramName) {
      params[node.paramName] = this.decodeParam(seg);
      rawParams[node.paramName] = seg;
      const result = this.matchNode(node.paramChild, segments, index + 1, params, rawParams, method);
      if (result) return result;
      delete params[node.paramName];
      delete rawParams[node.paramName];
    }

    // 3. Wildcard match (lowest priority, consumes rest)
    if (node.wildcardChild && node.wildcardName) {
      if (node.wildcardChild.routes.has(method)) {
        const raw = segments.slice(index).join("/");
        // A wildcard legitimately spans separators, so strictParams does not
        // apply here, decode as before.
        params[node.wildcardName] = decodeSegment(raw);
        rawParams[node.wildcardName] = raw;
        return node.wildcardChild;
      }
    }

    return null;
  }

  /** Check if any method is registered for this exact path (for 405 detection).
   *  Excludes wildcard catch-all matches to avoid CORS OPTIONS routes
   *  turning all 404s into 405s. */
  hasPath(pathname: string): boolean {
    const canonical = canonicalizePath(pathname, this.ignoreTrailingSlash);
    if (canonical === null) return false;
    if (this.staticRoutes.has(canonical)) return true;

    const segments = splitPath(canonical);
    return this._hasPath(this.root, segments, 0);
  }

  /**
   * The methods registered for this exact path, for the `Allow` header on a
   * 405. RFC 9110 makes `Allow` mandatory on `405 Method Not Allowed`, and
   * without it a client is told its method is wrong but not which ones are
   * right. Mirrors {@link hasPath}, wildcards excluded for the same reason.
   *
   * `HEAD` is reported wherever `GET` is registered, because the app really
   * does answer HEAD through its GET fallback. Reporting only what is
   * literally in the routing table would understate what the server accepts.
   */
  allowedMethods(pathname: string): RouteMethod[] {
    const canonical = canonicalizePath(pathname, this.ignoreTrailingSlash);
    if (canonical === null) return [];

    const found = new Set<RouteMethod>();
    const staticRoutes = this.staticRoutes.get(canonical);
    if (staticRoutes) {
      for (const method of staticRoutes.keys()) found.add(method);
    }
    this._collectMethods(this.root, splitPath(canonical), 0, found);

    if (found.has("GET")) found.add("HEAD");
    return METHOD_ORDER.filter((method) => found.has(method));
  }

  private _collectMethods(node: RadixNode, segments: string[], index: number, out: Set<RouteMethod>): void {
    if (index >= segments.length) {
      for (const method of node.routes.keys()) out.add(method);
      return;
    }
    const seg = segments[index]!;
    const staticChild = node.children.get(seg);
    if (staticChild) this._collectMethods(staticChild, segments, index + 1, out);
    if (node.paramChild) this._collectMethods(node.paramChild, segments, index + 1, out);
    // Wildcards excluded, see _hasPath.
  }

  private _hasPath(node: RadixNode, segments: string[], index: number): boolean {
    if (index >= segments.length) {
      return node.routes.size > 0;
    }
    const seg = segments[index]!;
    const staticChild = node.children.get(seg);
    if (staticChild && this._hasPath(staticChild, segments, index + 1)) return true;
    if (node.paramChild && this._hasPath(node.paramChild, segments, index + 1)) return true;
    // Intentionally exclude wildcardChild, a catch-all like OPTIONS /*path
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

/** Canonical order for the `Allow` header, so the value is stable across requests. */
const METHOD_ORDER: RouteMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

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

/**
 * Canonicalize an incoming request path, or return null if it is not canonical.
 *
 * `/admin`, `//admin`, `///admin`, `/admin//` and `/./admin` all used to reach
 * the same handler, which lets a request slip past an upstream rule written
 * against `= /admin`. Only one spelling is accepted here; the single allowed
 * variation is the trailing slash, and only when `ignoreTrailingSlash` is on.
 */
function canonicalizePath(pathname: string, ignoreTrailingSlash: boolean): string | null {
  if (pathname === "" || pathname === "/") return "/";
  if (pathname.charCodeAt(0) !== 47 /* '/' */) return null;

  // Empty segments ('//') are checked before the trailing slash is stripped,
  // so '/admin//' does not collapse into the legal '/admin/'.
  if (pathname.includes("//")) return null;

  let path = pathname;
  if (path.endsWith("/")) {
    if (!ignoreTrailingSlash) return null;
    path = path.slice(0, -1);
    if (path === "") return "/";
  }

  // Dot segments ('/./', '/../') are aliases, not paths.
  for (const seg of path.split("/")) {
    if (seg === "." || seg === "..") return null;
  }

  return path;
}

/** First registered route URL under a node, used to name a conflicting route. */
function findFirstRouteUrl(node: RadixNode): string | null {
  for (const route of node.routes.values()) {
    return route.url;
  }
  for (const child of node.children.values()) {
    const found = findFirstRouteUrl(child);
    if (found) return found;
  }
  if (node.paramChild) {
    const found = findFirstRouteUrl(node.paramChild);
    if (found) return found;
  }
  if (node.wildcardChild) {
    return findFirstRouteUrl(node.wildcardChild);
  }
  return null;
}
