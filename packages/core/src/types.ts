// @celsian/core — Type definitions

// ─── Hook Types ───

export type HookName =
  | 'onRequest'
  | 'preParsing'
  | 'preValidation'
  | 'preHandler'
  | 'preSerialization'
  | 'onSend'
  | 'onResponse'
  | 'onError';

export type HookHandler<T = void> = (
  request: CelsianRequest,
  reply: CelsianReply,
) => T | Promise<T>;

export type OnErrorHandler = (
  error: Error,
  request: CelsianRequest,
  reply: CelsianReply,
) => void | Response | Promise<void | Response>;

export type HookFunction = HookHandler<void | Response> | OnErrorHandler;

// ─── Request / Reply ───

export interface CelsianRequest extends Request {
  params: Record<string, string>;
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
  cookie(name: string, value: string, options?: import('./cookie.js').CookieOptions): CelsianReply;
  /** Clear a cookie by setting maxAge=0 */
  clearCookie(name: string, options?: import('./cookie.js').CookieOptions): CelsianReply;
  /** Read a file and send it with the correct MIME type */
  sendFile(filePath: string): Promise<Response>;
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

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type RouteHandler = (
  request: CelsianRequest,
  reply: CelsianReply,
) => Response | Promise<Response> | void | Promise<void>;

export interface RouteOptions {
  method: RouteMethod | RouteMethod[];
  url: string;
  handler: RouteHandler;
  /** Endpoint type */
  kind?: 'serverless' | 'hot' | 'task';
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
  kind: 'serverless' | 'hot' | 'task';
  schema?: RouteOptions['schema'];
  hooks: RouteHooks;
}

export interface RouteHooks {
  onRequest: HookHandler[];
  preHandler: HookHandler[];
  preSerialization: HookHandler[];
  onSend: HookHandler[];
}

// ─── Plugin ───

export type PluginFunction = (
  app: PluginContext,
  options: Record<string, unknown>,
) => void | Promise<void>;

export interface PluginOptions {
  prefix?: string;
  /** If false, plugin hooks/decorations affect parent scope (default: true) */
  encapsulate?: boolean;
}

export interface PluginContext {
  register(plugin: PluginFunction, options?: PluginOptions): Promise<void>;
  route(options: RouteOptions): void;
  get(url: string, handler: RouteHandler): void;
  post(url: string, handler: RouteHandler): void;
  put(url: string, handler: RouteHandler): void;
  patch(url: string, handler: RouteHandler): void;
  delete(url: string, handler: RouteHandler): void;

  addHook(name: 'onRequest', handler: HookHandler): void;
  addHook(name: 'preParsing', handler: HookHandler): void;
  addHook(name: 'preValidation', handler: HookHandler): void;
  addHook(name: 'preHandler', handler: HookHandler): void;
  addHook(name: 'preSerialization', handler: HookHandler): void;
  addHook(name: 'onSend', handler: HookHandler): void;
  addHook(name: 'onResponse', handler: HookHandler): void;
  addHook(name: 'onError', handler: OnErrorHandler): void;
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
  kind: 'serverless' | 'hot' | 'task';
}

export interface CelsianAppOptions {
  /** Base prefix for all routes */
  prefix?: string;
  /** Trust proxy headers */
  trustProxy?: boolean;
  /** Enable structured logging. true = default logger, or pass Logger instance */
  logger?: boolean | import('./logger.js').Logger;
  /** Max request body size in bytes (default: 1MB). Set to 0 to disable. */
  bodyLimit?: number;
  /** Per-request timeout in ms (default: 30000). Set to 0 to disable. */
  requestTimeout?: number;
}
