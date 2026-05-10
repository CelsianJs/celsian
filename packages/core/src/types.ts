// @celsian/core — Type definitions

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

// ─── Request / Reply ───

export interface CelsianRequest<TParams = Record<string, string>> extends Request {
  params: TParams;
  query: Record<string, string | string[]>;
  parsedBody: unknown;
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
  /** Read a file and send it with the correct MIME type. When options.root is set, filePath is resolved relative to root and path traversal is rejected with 403. Supports Range requests when options.request is provided. */
  sendFile(filePath: string, options?: SendFileOptions): Promise<Response>;
  /** Send a file as a download with Content-Disposition: attachment. Supports Range requests when options.request is provided. */
  download(filePath: string, filename?: string, options?: SendFileOptions): Promise<Response>;
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

// ─── sendFile Options ───

export interface SendFileOptions {
  /** Root directory for resolving relative file paths. Enables path traversal protection. */
  root?: string;
  /** Pass the incoming request to enable Range request support (206 Partial Content) and conditional GET (304). */
  request?: Request;
  /** File size threshold (bytes) above which a warning is logged. Default: 50MB. Set to 0 to disable. */
  largeFileThreshold?: number;
}

// ─── Route Handler ───

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type RouteHandler = (
  request: CelsianRequest,
  reply: CelsianReply,
) => Response | Promise<Response> | void | Promise<void>;

/** Route handler with typed params inferred from route string */
export type TypedRouteHandler<TParams = Record<string, string>> = (
  request: CelsianRequest<TParams>,
  reply: CelsianReply,
) => Response | Promise<Response> | void | Promise<void>;

// ─── Typed Schema Route Support ───

/** Schema options for route registration with type inference */
export interface RouteSchemaOptions<TBody = unknown, TQuery = unknown> {
  schema?: {
    body?: TBody;
    querystring?: TQuery;
    params?: unknown;
    response?: Record<number, unknown>;
  };
  onRequest?: HookHandler | HookHandler[];
  preHandler?: HookHandler | HookHandler[];
}

/**
 * CelsianRequest with typed parsedBody and parsedQuery inferred from schemas.
 * Extends the base CelsianRequest — used in typed route overloads.
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
> = (
  request: TypedCelsianRequest<TParams, TBody, TQuery>,
  reply: CelsianReply,
) => Response | Promise<Response> | void | Promise<void>;

export interface RouteOptions {
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
    response?: Record<number, unknown>;
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
  method: RouteMethod;
  url: string;
  handler: RouteHandler;
  kind: "serverless" | "hot" | "task";
  schema?: RouteOptions["schema"];
  hooks: RouteHooks;
  /** Pre-compiled JSON serializer built from schema.response at registration time */
  serializer?: ((data: unknown) => string) | null;
}

export interface RouteHooks {
  onRequest: HookHandler[];
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
  route(options: RouteOptions): void;

  // Overloaded: (path, handler) for backwards compat, (path, options, handler) for typed schemas
  get<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  get<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<
      ExtractRouteParams<T>,
      InferOutput<TBody>,
      TQuery extends unknown ? Record<string, string | string[]> : InferOutput<TQuery>
    >,
  ): void;

  post<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  post<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<
      ExtractRouteParams<T>,
      InferOutput<TBody>,
      TQuery extends unknown ? Record<string, string | string[]> : InferOutput<TQuery>
    >,
  ): void;

  put<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  put<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<
      ExtractRouteParams<T>,
      InferOutput<TBody>,
      TQuery extends unknown ? Record<string, string | string[]> : InferOutput<TQuery>
    >,
  ): void;

  patch<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  patch<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<
      ExtractRouteParams<T>,
      InferOutput<TBody>,
      TQuery extends unknown ? Record<string, string | string[]> : InferOutput<TQuery>
    >,
  ): void;

  delete<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  delete<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<
      ExtractRouteParams<T>,
      InferOutput<TBody>,
      TQuery extends unknown ? Record<string, string | string[]> : InferOutput<TQuery>
    >,
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
  decorateRequest(name: string, value: unknown): void;
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
  /** Enable structured logging. true = default logger, or pass Logger instance */
  logger?: boolean | import("./logger.js").Logger;
  /** Max request body size in bytes (default: 1MB). Set to 0 to disable. */
  bodyLimit?: number;
  /** Per-request timeout in ms (default: 30000). Set to 0 to disable. */
  requestTimeout?: number;
  /**
   * Security headers configuration. Security headers are enabled by default.
   * Pass `false` to disable, `true` for defaults, or a SecurityOptions object to customize.
   */
  security?: boolean | import("./plugins/security.js").SecurityOptions;
}
