// @celsian/core, Type definitions

import type { InferOutput } from "@celsian/schema";

// ─── Route Parameter Extraction (Hono/Elysia-style) ───

/**
 * Extract route parameter names from a route string pattern.
 *
 * Examples:
 *   ExtractRouteParams<'/users/:id'>           → { id: string }
 *   ExtractRouteParams<'/users/:id/posts/:pid'> → { id: string; pid: string }
 *   ExtractRouteParams<'/static/*'>             → { '*': string }
 *   ExtractRouteParams<'/no-params'>            → {}
 */
export type ExtractRouteParams<T extends string> = T extends `${string}:${infer Param}/${infer Rest}`
  ? { [K in Param | keyof ExtractRouteParams<`/${Rest}`>]: string }
  : T extends `${string}:${infer Param}`
    ? { [K in Param]: string }
    : T extends `${string}*`
      ? { "*": string }
      : {};

// ─── Hook Types ───

export type HookName =
  | "onRequest"
  | "preParsing"
  | "preValidation"
  | "preHandler"
  | "preSerialization"
  | "onSend"
  | "onResponse"
  | "onError";

export type HookHandler<T = void | Response> = (request: CelsianRequest, reply: CelsianReply) => T | Promise<T>;

export type OnErrorHandler = (
  error: Error,
  request: CelsianRequest,
  reply: CelsianReply,
) => void | Response | Promise<void | Response>;

export type HookFunction = HookHandler<void | Response> | OnErrorHandler;

// ─── Resolved encapsulation scope ───

/**
 * Key under which a route's resolved encapsulation scope is attached to its
 * `onRequest` hook chain.
 *
 * The router builds `InternalRoute` objects itself, so the scope travels on the
 * (context-owned) hook array rather than on the route object. Reading it is a
 * single property access on the hot path.
 */
export const ROUTE_SCOPE: unique symbol = Symbol("celsian.routeScope");

/**
 * Every hook list and decoration map that applies to one route, resolved by
 * walking its encapsulation-context chain from the root down to the context the
 * route was registered in, then appending the route's own options-level hooks.
 *
 * The arrays are mutated in place when the chain changes (a hook added after the
 * route was registered, a plugin registered later), so the router's route object
 * always sees the current chain with no per-request work.
 */
export interface ResolvedScope {
  onRequest: HookHandler[];
  preParsing: HookHandler[];
  preValidation: HookHandler[];
  preHandler: HookHandler[];
  preSerialization: HookHandler[];
  onSend: HookHandler[];
  onResponse: HookHandler[];
  onError: OnErrorHandler[];
  requestDecorations: Map<PropertyKey, unknown>;
  replyDecorations: Map<string, unknown>;
}

/** An `onRequest` hook array carrying its route's resolved scope. See {@link ROUTE_SCOPE}. */
export interface RouteHookChain extends Array<HookHandler> {
  [ROUTE_SCOPE]?: ResolvedScope;
}

// ─── Request / Reply ───

export interface CelsianRequest<TParams = Record<string, string>> extends Request {
  params: TParams;
  query: Record<string, string | string[]>;
  parsedBody: unknown;
  /**
   * Cookies parsed from the request's `Cookie` header, populated lazily on
   * first access. Always present: the app defines it on every request, not a
   * plugin. Declared here so reads are typed rather than falling through to
   * the plugin index signature below and arriving as `unknown`.
   */
  cookies: Record<string, string>;
  /** Populated by plugins */
  [key: string]: unknown;
}

export interface CelsianReply {
  /** Allow plugin-added properties */
  [key: string]: unknown;
  status(code: number): CelsianReply;
  header(key: string, value: string): CelsianReply;
  headers: Record<string, string>;
  statusCode: number;
  send(data: unknown): Response;
  html(content: string): Response;
  json(data: unknown): Response;
  stream(readable: ReadableStream): Response;
  redirect(url: string, code?: number): Response;
  /** Set a cookie on the response */
  cookie(name: string, value: string, options?: import("./cookie.js").CookieOptions): CelsianReply;
  /** Clear a cookie by setting maxAge=0 */
  clearCookie(name: string, options?: import("./cookie.js").CookieOptions): CelsianReply;
  /** Read a file and send it with the correct MIME type. When options.root is set, filePath is resolved relative to root and path traversal is rejected with 403. */
  sendFile(filePath: string, options?: { root?: string }): Promise<Response>;
  /** Send a file as a download with Content-Disposition: attachment */
  download(filePath: string, filename?: string): Promise<Response>;
  /** Has a response already been sent? */
  sent: boolean;

  // ─── Status Code Helpers ───
  notFound(message?: string): Response;
  badRequest(message?: string): Response;
  unauthorized(message?: string): Response;
  forbidden(message?: string): Response;
  conflict(message?: string): Response;
  gone(message?: string): Response;
  tooManyRequests(message?: string): Response;
  internalServerError(message?: string): Response;
  serviceUnavailable(message?: string): Response;
}

// ─── Route Handler ───

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * What a route handler may return.
 *
 * A `Response` is sent as-is, `undefined` produces a 204, a string is sent as
 * `text/plain`, and anything else is JSON-serialized. Deliberately permissive so
 * that returning plain data, `app.get('/x', () => ({ message: 'world' }))`, the
 * pattern used throughout the docs, type-checks.
 */
export type RouteResult = Response | void | unknown;

export type RouteHandler = (request: CelsianRequest, reply: CelsianReply) => RouteResult;

/** Route handler with typed params inferred from route string */
export type TypedRouteHandler<TParams = Record<string, string>> = (
  request: CelsianRequest<TParams>,
  reply: CelsianReply,
) => RouteResult;

// ─── Typed Schema Route Support ───

/**
 * Response schemas keyed by status code, with an optional `default` fallback
 * applied to any status without an explicit entry.
 */
export type ResponseSchemaMap = Record<number, unknown> & { default?: unknown };

/**
 * What `schema.response` accepts, in either of its two spellings:
 *
 * - a {@link ResponseSchemaMap}, `{ 200: schema, default: schema }`
 * - a bare schema object, applied to every 2xx response
 *
 * The bare spelling is the one that mirrors `schema.body` and
 * `schema.querystring`, so it has to work. The union is widened to `object`
 * rather than to a structural schema shape because the four supported
 * libraries (Zod, TypeBox, Valibot, Celsian's own `StandardSchema`) share no
 * common property. `object` still rejects primitives, and the two forms are
 * told apart at registration by their own keys, see `resolveResponseSchema`.
 */
export type RouteResponseSchema = ResponseSchemaMap | object;

/** Declarative documentation only; authentication still requires runtime hooks. */
export interface RouteOpenAPIOptions {
  description?: string;
  /** Named schemes declared in openapi({ securitySchemes }). [] means no auth. */
  security?: Array<Record<string, string[]>>;
  /**
   * Additional request parameters, e.g. a double-submit CSRF header. Matching
   * (in, name) entries override earlier/inferred fields; schemas replace whole
   * schemas. Unspecified fields are retained, and path parameters stay required.
   */
  parameters?: Array<{
    name: string;
    in: "header" | "query" | "path" | "cookie";
    required?: boolean;
    description?: string;
    schema: Record<string, unknown>;
  }>;
}

/**
 * Resolve the handler's `parsedQuery` type from a `querystring` schema.
 *
 * When no querystring schema is supplied the generic is inferred as `unknown`,
 * in which case the handler keeps the raw string record. Written as
 * `unknown extends TQuery` because that is true only for `unknown`/`any`,
 * `TQuery extends unknown` is true for *every* type and made the typed branch
 * unreachable.
 */
export type InferQuery<TQuery> = unknown extends TQuery ? Record<string, string | string[]> : InferOutput<TQuery>;

/** Schema options for route registration with type inference */
export interface RouteSchemaOptions<TBody = unknown, TQuery = unknown, TParams = Record<string, string>> {
  openapi?: RouteOpenAPIOptions;
  schema?: {
    body?: TBody;
    querystring?: TQuery;
    params?: unknown;
    response?: RouteResponseSchema;
  };
  /**
   * Route handler (Fastify-style options-object signature):
   * `app.post('/x', { schema, handler })`. A trailing handler argument,
   * when provided, takes precedence over this property.
   */
  handler?: TypedSchemaHandler<TParams, InferOutput<TBody>, InferQuery<TQuery>>;
  onRequest?: HookHandler | HookHandler[];
  preHandler?: HookHandler | HookHandler[];
}

/**
 * CelsianRequest with typed parsedBody and parsedQuery inferred from schemas.
 * Extends the base CelsianRequest, used in typed route overloads.
 */
export interface TypedCelsianRequest<
  TParams = Record<string, string>,
  TBody = unknown,
  TQuery = Record<string, string | string[]>,
> extends CelsianRequest<TParams> {
  parsedBody: TBody;
  parsedQuery: TQuery;
}

/** Route handler with typed params, body, and query inferred from schemas */
export type TypedSchemaHandler<
  TParams = Record<string, string>,
  TBody = unknown,
  TQuery = Record<string, string | string[]>,
> = (request: TypedCelsianRequest<TParams, TBody, TQuery>, reply: CelsianReply) => RouteResult;

export interface RouteOptions {
  openapi?: RouteOpenAPIOptions;
  method: RouteMethod | RouteMethod[];
  url: string;
  handler: RouteHandler;
  /** Endpoint type */
  kind?: "serverless" | "hot" | "task";
  /** Schema for validation */
  schema?: {
    body?: unknown;
    querystring?: unknown;
    params?: unknown;
    response?: RouteResponseSchema;
  };
  /** Route-specific hooks */
  onRequest?: HookHandler | HookHandler[];
  preHandler?: HookHandler | HookHandler[];
  preSerialization?: HookHandler | HookHandler[];
  onSend?: HookHandler | HookHandler[];
}

/**
 * Route options with typed schema inference for parsedBody and parsedQuery.
 *
 * `TUrl` is a generic so the url string literal reaches
 * {@link ExtractRouteParams}, exactly as it does for `app.get(url, ...)`.
 * Without it `url` was a plain `string`, there was no literal to extract from,
 * and `app.route({ url: '/users/:id' })` degraded `req.params` to
 * `Record<string, string>` while `app.post('/users/:id')` typed it as
 * `{ id: string }`. Same route, same framework, two different types.
 */
export interface TypedRouteOptions<
  TBody = unknown,
  TQuery = unknown,
  TUrl extends string = string,
  TParams = ExtractRouteParams<TUrl>,
> {
  openapi?: RouteOpenAPIOptions;
  method: RouteMethod | RouteMethod[];
  url: TUrl;
  handler: TypedSchemaHandler<TParams, InferOutput<TBody>, InferQuery<TQuery>>;
  /** Endpoint type */
  kind?: "serverless" | "hot" | "task";
  /** Schema for validation */
  schema?: {
    body?: TBody;
    querystring?: TQuery;
    params?: unknown;
    response?: RouteResponseSchema;
  };
  /** Route-specific hooks */
  onRequest?: HookHandler | HookHandler[];
  preHandler?: HookHandler | HookHandler[];
  preSerialization?: HookHandler | HookHandler[];
  onSend?: HookHandler | HookHandler[];
}

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
  route: InternalRoute;
}

export interface InternalRoute {
  openapi?: RouteOpenAPIOptions;
  method: RouteMethod;
  url: string;
  handler: RouteHandler;
  kind: "serverless" | "hot" | "task";
  schema?: RouteOptions["schema"];
  hooks: RouteHooks;
}

export interface RouteHooks {
  /** Carries the route's {@link ResolvedScope}, see {@link ROUTE_SCOPE}. */
  onRequest: RouteHookChain;
  preHandler: HookHandler[];
  preSerialization: HookHandler[];
  onSend: HookHandler[];
}

// ─── Plugin ───

export type PluginFunction = (app: PluginContext, options: Record<string, unknown>) => void | Promise<void>;

export interface PluginOptions {
  prefix?: string;
  /** If false, plugin hooks/decorations affect parent scope (default: true) */
  encapsulate?: boolean;
}

export interface PluginContext {
  register(plugin: PluginFunction, options?: PluginOptions): Promise<void>;
  // Typed overload first: overload resolution picks the first match, and the
  // untyped RouteOptions signature would otherwise erase schema inference.
  route<TBody, TQuery, TUrl extends string>(options: TypedRouteOptions<TBody, TQuery, TUrl>): void;
  route(options: RouteOptions): void;

  // Overloaded: (path, handler) for backwards compat, (path, options, handler) for typed schemas
  get<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  get<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>, InferOutput<TBody>, InferQuery<TQuery>>,
  ): void;
  get<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>> & {
      handler: TypedSchemaHandler<ExtractRouteParams<T>, InferOutput<TBody>, InferQuery<TQuery>>;
    },
  ): void;

  post<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  post<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>, InferOutput<TBody>, InferQuery<TQuery>>,
  ): void;
  post<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>> & {
      handler: TypedSchemaHandler<ExtractRouteParams<T>, InferOutput<TBody>, InferQuery<TQuery>>;
    },
  ): void;

  put<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  put<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>, InferOutput<TBody>, InferQuery<TQuery>>,
  ): void;
  put<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>> & {
      handler: TypedSchemaHandler<ExtractRouteParams<T>, InferOutput<TBody>, InferQuery<TQuery>>;
    },
  ): void;

  patch<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  patch<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>, InferOutput<TBody>, InferQuery<TQuery>>,
  ): void;
  patch<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>> & {
      handler: TypedSchemaHandler<ExtractRouteParams<T>, InferOutput<TBody>, InferQuery<TQuery>>;
    },
  ): void;

  delete<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  delete<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>, InferOutput<TBody>, InferQuery<TQuery>>,
  ): void;
  delete<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery, ExtractRouteParams<T>> & {
      handler: TypedSchemaHandler<ExtractRouteParams<T>, InferOutput<TBody>, InferQuery<TQuery>>;
    },
  ): void;

  addHook(name: "onRequest", handler: HookHandler): void;
  addHook(name: "preParsing", handler: HookHandler): void;
  addHook(name: "preValidation", handler: HookHandler): void;
  addHook(name: "preHandler", handler: HookHandler): void;
  addHook(name: "preSerialization", handler: HookHandler): void;
  addHook(name: "onSend", handler: HookHandler): void;
  addHook(name: "onResponse", handler: HookHandler): void;
  addHook(name: "onError", handler: OnErrorHandler): void;
  addHook(name: HookName, handler: HookHandler | OnErrorHandler): void;

  decorate(name: string, value: unknown): void;
  /** Decorate requests in this plugin scope, or every request in the current app with `scope: "app"`. */
  decorateRequest(name: PropertyKey, value: unknown, options?: { scope?: "plugin" | "app" }): void;
  /**
   * Read back a request decoration set on this plugin scope, or on the app root
   * with `scope: "app"`. Returns `undefined` when it was never set.
   *
   * Needed by plugins that must be aware of their own prior registrations, e.g.
   * a multi-realm auth plugin that has to refuse to guess which realm an
   * unbound guard belongs to. Without a read there is no way to distinguish
   * "one realm" from "several", and last-writer-wins fails OPEN.
   */
  getRequestDecoration(name: PropertyKey, options?: { scope?: "plugin" | "app" }): unknown;
  decorateReply(name: string, value: unknown): void;

  /** Return all registered routes (collected from the router). */
  getRoutes(): InternalRoute[];
}

// ─── App Config ───

export interface RouteManifestEntry {
  method: RouteMethod;
  url: string;
  kind: "serverless" | "hot" | "task";
}

export interface CelsianAppOptions {
  /** Base prefix for all routes */
  prefix?: string;
  /** Trust proxy headers */
  trustProxy?: boolean;
  /**
   * Allowlist of host values that may be honored from the `x-forwarded-host`
   * header when `trustProxy` is enabled. If unset, `x-forwarded-host` is
   * ignored and the real `Host` header is always used (prevents host-header
   * injection). Match values exactly, including any non-default port
   * (e.g. `"example.com"`, `"example.com:8443"`). `x-forwarded-proto` is
   * always honored when `trustProxy` is enabled.
   */
  trustedHosts?: string[];
  /** Enable structured logging. true = default logger, or pass Logger instance */
  logger?: boolean | import("./logger.js").Logger;
  /** Max request body size in bytes (default: 1MB). Set to 0 to disable. */
  bodyLimit?: number;
  /** Per-request timeout in ms (default: 30000). Set to 0 to disable. */
  requestTimeout?: number;
  /**
   * Validate outgoing responses against a route's `schema.response` (default: true).
   * Only routes that declare response schemas are affected. A mismatch produces a
   * generic 500 and is logged server-side. Set to `false` to skip the check.
   */
  validateResponses?: boolean;
}
