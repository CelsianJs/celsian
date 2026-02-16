// @celsian/server — Type definitions

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

export type HookHandler = (
  request: CelsianRequest,
  reply: CelsianReply,
) => void | Response | Promise<void | Response>;

export type OnErrorHandler = (
  error: Error,
  request: CelsianRequest,
  reply: CelsianReply,
) => void | Response | Promise<void | Response>;

export type HookFunction = HookHandler | OnErrorHandler;

// ─── Request / Reply ───

export interface CelsianRequest extends Request {
  params: Record<string, string>;
  query: Record<string, string>;
  parsedBody: unknown;
  /** Populated by plugins */
  [key: string]: unknown;
}

export interface CelsianReply {
  status(code: number): CelsianReply;
  header(key: string, value: string): CelsianReply;
  headers: Record<string, string>;
  statusCode: number;
  send(data: unknown): Response;
  html(content: string): Response;
  json(data: unknown): Response;
  stream(readable: ReadableStream): Response;
  redirect(url: string, code?: number): Response;
  /** Has a response already been sent? */
  sent: boolean;
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
}

// ─── Plugin ───

export type PluginFunction = (
  app: PluginContext,
  options: Record<string, unknown>,
) => void | Promise<void>;

/** Symbol to mark plugins that should skip encapsulation */
export const kSkipOverride: unique symbol = Symbol.for('celsian.skipOverride');

/**
 * Wrap a plugin to skip encapsulation — hooks and decorators
 * leak to the parent scope (like fastify-plugin).
 * Use this for middleware that should affect all routes (CORS, auth, logging).
 */
export function fp(plugin: PluginFunction): PluginFunction {
  const wrapped = plugin as PluginFunction & { [kSkipOverride]?: boolean };
  wrapped[kSkipOverride] = true;
  return wrapped;
}

export interface PluginOptions {
  prefix?: string;
}

export interface PluginContext {
  // Registration
  register(plugin: PluginFunction, options?: PluginOptions): Promise<void>;
  route(options: RouteOptions): void;
  get(url: string, handler: RouteHandler): void;
  post(url: string, handler: RouteHandler): void;
  put(url: string, handler: RouteHandler): void;
  patch(url: string, handler: RouteHandler): void;
  delete(url: string, handler: RouteHandler): void;

  // Hooks
  addHook(name: 'onRequest', handler: HookHandler): void;
  addHook(name: 'preParsing', handler: HookHandler): void;
  addHook(name: 'preValidation', handler: HookHandler): void;
  addHook(name: 'preHandler', handler: HookHandler): void;
  addHook(name: 'preSerialization', handler: HookHandler): void;
  addHook(name: 'onSend', handler: HookHandler): void;
  addHook(name: 'onResponse', handler: HookHandler): void;
  addHook(name: 'onError', handler: OnErrorHandler): void;
  addHook(name: HookName, handler: HookHandler | OnErrorHandler): void;

  // Decorators
  decorate(name: string, value: unknown): void;
  decorateRequest(name: string, value: unknown): void;
}

// ─── App Config ───

export interface CelsianAppOptions {
  /** Base prefix for all routes */
  prefix?: string;
  /** Trust proxy headers */
  trustProxy?: boolean;
}
