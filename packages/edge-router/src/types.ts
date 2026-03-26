/** A single route entry in the edge router's routing table. */
export interface RouteEntry {
  /** URL pattern, e.g. "/api/users/:id" */
  pattern: string;
  /** HTTP methods this route handles */
  methods: string[];
  /** Backend origin to proxy to */
  origin: string;
  /** Optional path rewrite, e.g. "/v2/users/:id" */
  rewrite?: string;
  /** Optional headers to add to the proxied request */
  headers?: Record<string, string>;
}

/** Compiled route with regex for fast matching. */
export interface CompiledRoute {
  entry: RouteEntry;
  regex: RegExp;
  paramNames: string[];
  methods: Set<string>;
}

/** Edge router configuration. */
export interface EdgeRouterConfig {
  routes: RouteEntry[];
  /** CORS configuration — if set, the router handles preflight automatically */
  cors?: CorsConfig;
  /** Default origin for routes that don't specify one */
  defaultOrigin?: string;
}

/** CORS configuration. */
export interface CorsConfig {
  origin: string | string[] | ((origin: string) => boolean);
  methods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/** Route match result from the matcher. */
export interface RouteMatch {
  route: CompiledRoute;
  params: Record<string, string>;
}

/** Result from the update-routes API. */
export interface UpdateRoutesResult {
  success: boolean;
  routeCount: number;
  error?: string;
}
