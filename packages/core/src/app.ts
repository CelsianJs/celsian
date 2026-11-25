// @celsian/core, CelsianApp: hook-based server with plugin encapsulation

import type { InferOutput, StandardSchema } from "@celsian/schema";
import { parseBodyIfAny } from "./body-parser.js";
import { EncapsulationContext, type ScopeRegistry } from "./context.js";
import { type CronJob, CronScheduler } from "./cron.js";
import { handleErrorNow } from "./error-handler.js";
import { assertPlugin, CelsianError, HttpError, ValidationError, wrapNonError } from "./errors.js";
import {
  fastResponse,
  getFastPayload,
  type Outgoing,
  peekHeaders,
  toResponse,
  WireResponse,
  wireHeaders,
} from "./fast-response.js";
import { isThenable, runHooksFireAndForget, runHooksUntilAnswer, runOnSendHooksNow, toPromise } from "./hooks.js";
import { createInject, type InjectOptions } from "./inject.js";
import { createLogger, generateRequestId, type Logger } from "./logger.js";
import { MemoryQueue, type QueueBackend } from "./queue.js";
import { createReply, replyCookies } from "./reply.js";
import {
  applyForwardedAuthority,
  armRequestTimeout,
  buildRequest,
  buildRequestFast,
  disarmRequestTimeout,
  type ForwardedTrustOptions,
  fireRequestTimeout,
  remoteAddressFromServeContext,
  resolveClientIp,
  setRemoteAddress,
} from "./request.js";
import { mergeReply } from "./response-merge.js";
import { resolveResponseSchema } from "./response-schema.js";
import { ROUTE_VALIDATORS, type RouteWithValidators, responseValidatorFor, validatorFor } from "./route-validators.js";
import { Router } from "./router.js";
import { createEnqueue, type TaskDefinition, TaskRegistry, TaskWorker, type TaskWorkerOptions } from "./task.js";
import {
  type CelsianAppOptions,
  type CelsianReply,
  type CelsianRequest,
  type ExtractRouteParams,
  type HookHandler,
  type HookName,
  type InferQuery,
  type InternalRoute,
  type OnErrorHandler,
  type PluginContext,
  type PluginFunction,
  type PluginOptions,
  type ResolvedScope,
  ROUTE_SCOPE,
  type RouteHandler,
  type RouteManifestEntry,
  type RouteMethod,
  type RouteOptions,
  type RouteSchemaOptions,
  type TypedRouteHandler,
  type TypedRouteOptions,
  type TypedSchemaHandler,
} from "./types.js";
import { type WSHandler, WSRegistry } from "./websocket.js";

/** Shared decoder for response bodies that were serialized as bytes. */
const RESPONSE_DECODER = new TextDecoder();

/** The bodiless answer to a HEAD request: the status and headers `out` would have been sent with. */
function headOf(out: Outgoing): Response {
  return new Response(null, {
    status: out.status,
    headers: out instanceof WireResponse ? wireHeaders(out) : out.headers,
  });
}

/**
 * True when `prefix` scopes `pathname`: an exact match, or a path-segment
 * prefix. `/api` covers `/api` and `/api/chat`, but not `/apix`.
 */
function prefixCoversPath(prefix: string, pathname: string): boolean {
  if (prefix === "" || prefix === "/") return true;
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Run `callback` before any timer, I/O or immediate callback can run, and, on
 * Node, only once the microtask queue has drained: after every promise
 * reaction already queued, and every one those queue in turn. `undefined`
 * where the runtime has no `process.nextTick`.
 *
 * A `process.nextTick` runs before the event loop moves on, on every runtime
 * that has one. On Node, one queued from inside a microtask runs only when
 * Node has drained V8's microtask queue. Bun runs it at the same point except
 * after a top-level await, and other runtimes may run it as a microtask, so
 * there it can come before the last microtask: never later than a timer would.
 * Captured at load, so a test that fakes timers does not reach it.
 */
const afterMicrotasks: ((callback: () => void) => void) | undefined = (() => {
  const nextTick = (globalThis as { process?: { nextTick?: unknown } }).process?.nextTick;
  if (typeof nextTick !== "function" || typeof queueMicrotask !== "function") return undefined;
  const queue = queueMicrotask;
  return (callback) => queue(() => (nextTick as (callback: () => void) => void)(callback));
})();

/** What request logging needs to report a request's outcome. Only built when a logger is set. */
interface RequestTrace {
  method: string;
  pathname: string;
  requestId: string;
  start: number;
}

/** Reaches `CelsianApp`'s private request entry point; set by the class's static initializer. */
let dispatch: (app: CelsianApp, request: Request) => Outgoing | Promise<Outgoing>;

/**
 * `app.handle()` for core's own Node server. The answer may be a fast response
 * with its final headers still beside it (see `WireResponse`), which that
 * server writes directly; `handle()` turns it into a Response for everyone
 * else. It also comes back without a promise when the request was answered
 * synchronously, and then a failure is thrown rather than a rejection.
 * Internal to core: not exported from the package.
 */
export function dispatchRequest(app: CelsianApp, request: Request): Outgoing | Promise<Outgoing> {
  return dispatch(app, request);
}

/** `CelsianApp.prototype.handle` as this module defined it; set by the class's static initializer. */
let stockHandle: CelsianApp["handle"];

/**
 * True when `handle`, what `app.handle` read as, is the method this module
 * defined, so that calling {@link dispatchRequest} instead is the same as
 * calling it. False when it was replaced on the instance, overridden by a
 * subclass, or replaced on `CelsianApp.prototype` itself: that last case is
 * why this compares with the method as it was when the module loaded, not
 * with the prototype's current one. The caller reads `app.handle` once and
 * calls what it read, so an accessor is asked once. Internal to core: not
 * exported from the package.
 */
export function isStockHandle(handle: unknown): boolean {
  return handle === stockHandle;
}

/**
 * The main application class. Provides routing, hooks, plugins, task queues, cron,
 * WebSocket, and request handling -- all built on Web Standard APIs.
 *
 * @example
 * ```ts
 * const app = new CelsianApp({ logger: true });
 * app.get('/hello', (req, reply) => reply.json({ hi: true }));
 * ```
 */
export class CelsianApp {
  // Pre-stringified error responses (avoid JSON.stringify on every miss)
  private static readonly NOT_FOUND_BODY = JSON.stringify({ error: "Not Found", statusCode: 404, code: "NOT_FOUND" });
  private static readonly METHOD_NOT_ALLOWED_BODY = JSON.stringify({
    error: "Method Not Allowed",
    statusCode: 405,
    code: "METHOD_NOT_ALLOWED",
  });
  private static readonly RESPONSE_VALIDATION_BODY = JSON.stringify({
    error: "Internal Server Error",
    statusCode: 500,
    code: "RESPONSE_VALIDATION_FAILED",
  });
  private static readonly JSON_CONTENT_TYPE: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };

  static {
    dispatch = (app, request) => app.dispatch(request);
    stockHandle = CelsianApp.prototype.handle;
  }

  private router = new Router();
  private rootContext: EncapsulationContext;
  private pluginContext: PluginContext;
  /** Shared registry that resolves every route's hook chain from its context chain. */
  private readonly scopes: ScopeRegistry;
  /** Scope of the root context, used by requests that never matched a route. */
  private readonly rootScope: ResolvedScope;
  /** Memoized route-less scopes for contexts consulted by {@link onRequestHooksForPath}. */
  private readonly pathScopes = new Map<EncapsulationContext, ResolvedScope>();
  private pendingPlugins: Promise<void>[] = [];
  private readyPromise: Promise<void> | null = null;
  readonly log: Logger;

  // Task/queue system
  private taskRegistry = new TaskRegistry();
  private _queue: QueueBackend = new MemoryQueue();
  private taskWorker: TaskWorker | null = null;
  private taskWorkerOptions: TaskWorkerOptions = {};

  // Custom handlers
  private notFoundHandler: RouteHandler | null = null;
  private errorHandler:
    | ((error: Error, request: CelsianRequest, reply: CelsianReply) => Response | Promise<Response>)
    | null = null;

  // Custom content-type parsers
  private contentTypeParsers = new Map<string, (request: Request) => Promise<unknown>>();

  // Cron scheduling
  private cronScheduler = new CronScheduler();

  // WebSocket
  readonly wsRegistry = new WSRegistry();

  // Serverless safety warnings (one-time)
  private _enqueuedWithoutWorkerWarned = false;
  private _cronNotStartedWarned = false;

  // Cached options for hot path
  private readonly hasLogger: boolean;
  private readonly cachedBodyLimit: number;
  private readonly cachedRequestTimeout: number;
  private readonly responseValidationEnabled: boolean;

  // True when the user supplied no logger and we fell back to the silent no-op.
  // Safety warnings escalate to console.warn in that case so they stay visible.
  private readonly usingNoopLogger: boolean;

  constructor(private options: CelsianAppOptions = {}) {
    this.rootContext = new EncapsulationContext(null, options.prefix ?? "", this.router);
    this.pluginContext = this.rootContext.toPluginContext();
    this.scopes = this.rootContext.scopes;
    this.rootScope = this.rootContext.createContextScope();

    // Cache hot-path options
    this.hasLogger = !!options.logger;
    this.cachedBodyLimit = options.bodyLimit ?? 1_048_576;
    this.cachedRequestTimeout = options.requestTimeout ?? 30_000;
    this.responseValidationEnabled = options.validateResponses !== false;

    const clientIp = options.clientIp;
    if (clientIp !== undefined) {
      // A blank header or a hop count below 1 can never name a client, so every
      // request would silently report the proxy's address instead.
      if (typeof clientIp.header !== "string" || clientIp.header.trim() === "") {
        throw new CelsianError("clientIp.header must name the header your proxy sets, e.g. 'fly-client-ip'.");
      }
      if (clientIp.hops !== undefined && (!Number.isInteger(clientIp.hops) || clientIp.hops < 1)) {
        throw new CelsianError(`clientIp.hops must be an integer >= 1, got ${String(clientIp.hops)}.`);
      }
    }

    // Logger setup
    this.usingNoopLogger = !options.logger;
    if (options.logger === true) {
      this.log = createLogger();
    } else if (options.logger && typeof options.logger === "object") {
      this.log = options.logger;
    } else {
      // Silent no-op logger
      const noop = () => {};
      this.log = {
        level: "info" as const,
        trace: noop,
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        fatal: noop,
        child: () => this.log,
      };
    }
  }

  // ─── Registration (delegate to plugin context) ───

  /** Register a plugin with optional prefix and encapsulation settings. */
  async register(plugin: PluginFunction, options?: PluginOptions): Promise<void> {
    assertPlugin(plugin);
    const before = new Set(this.rootContext.collectAllDecorations().keys());
    const p = this.pluginContext.register(plugin, options).then(() => {
      // Sync new decorations from plugin context and all child contexts to app instance.
      // This ensures decorations from encapsulated plugins (e.g. jwt) are accessible
      // on the app instance even without { encapsulate: false }.
      for (const [name, value] of this.rootContext.collectAllDecorations()) {
        if (!before.has(name) && !(name in this)) {
          Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
        }
      }
    });
    this.pendingPlugins.push(p);
    return p;
  }

  /**
   * Register a route with full options (method, url, schema, hooks, handler).
   *
   * The typed overload is declared first so a `schema` actually reaches the
   * handler: overload resolution picks the first match, and the untyped
   * `RouteOptions` signature would otherwise always win and erase the inference.
   */
  route<TBody, TQuery, TUrl extends string>(options: TypedRouteOptions<TBody, TQuery, TUrl>): void;
  route(options: RouteOptions): void;
  route(options: RouteOptions | TypedRouteOptions): void {
    this.pluginContext.route(options as RouteOptions);
  }

  // Overloaded route methods: (path, handler) and (path, options, handler)
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
  get<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    if (typeof handlerOrOpts === "function") {
      this.pluginContext.get(url, handlerOrOpts);
    } else {
      this._routeWithSchema("GET", url, handlerOrOpts, handler);
    }
  }

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
  post<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    if (typeof handlerOrOpts === "function") {
      this.pluginContext.post(url, handlerOrOpts);
    } else {
      this._routeWithSchema("POST", url, handlerOrOpts, handler);
    }
  }

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
  put<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    if (typeof handlerOrOpts === "function") {
      this.pluginContext.put(url, handlerOrOpts);
    } else {
      this._routeWithSchema("PUT", url, handlerOrOpts, handler);
    }
  }

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
  patch<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    if (typeof handlerOrOpts === "function") {
      this.pluginContext.patch(url, handlerOrOpts);
    } else {
      this._routeWithSchema("PATCH", url, handlerOrOpts, handler);
    }
  }

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
  delete<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    if (typeof handlerOrOpts === "function") {
      this.pluginContext.delete(url, handlerOrOpts);
    } else {
      this._routeWithSchema("DELETE", url, handlerOrOpts, handler);
    }
  }

  /** Internal: register a route with schema options from the typed overload */
  private _routeWithSchema(
    method: import("./types.js").RouteMethod,
    url: string,
    opts: RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    // Fastify-style options-object signature: app.post(url, { schema, handler }).
    // A trailing handler argument takes precedence over opts.handler.
    const resolvedHandler = handler ?? opts.handler;
    if (typeof resolvedHandler !== "function") {
      throw new CelsianError(
        `Route ${method} ${url} has no handler. Pass it as the last argument, app.${method.toLowerCase()}(url, opts, handler), or as opts.handler.`,
      );
    }
    this.pluginContext.route({
      method,
      url,
      // Safe cast: at runtime, the request object will have parsedBody/parsedQuery
      // populated by validateRequest before the handler is called
      handler: resolvedHandler as unknown as RouteHandler,
      schema: opts.schema,
      openapi: opts.openapi,
      onRequest: opts.onRequest,
      preHandler: opts.preHandler,
    });
  }

  /** Add a lifecycle hook (onRequest, preHandler, onSend, onError, etc.). */
  addHook(name: "onError", handler: OnErrorHandler): void;
  addHook(name: Exclude<HookName, "onError">, handler: HookHandler): void;
  addHook(name: HookName, handler: HookHandler | OnErrorHandler): void {
    this.pluginContext.addHook(name, handler as HookHandler);
  }

  /** Add a named property to the app instance, accessible from all routes and plugins. */
  decorate(name: string, value: unknown): void {
    this.pluginContext.decorate(name, value);
    Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
  }

  getDecoration(name: string): unknown {
    return this.rootContext.collectAllDecorations().get(name);
  }

  /**
   * The `onRequest` chain that gates a connection upgrade (WebSocket) at `pathname`.
   *
   * An upgrade never matches a route, so the chain is resolved from the
   * encapsulation tree instead: the app's own `addHook('onRequest', ...)` hooks,
   * plus every hook contributed by a plugin whose scope covers `pathname`. That
   * covers both registration forms:
   *
   * - `app.register(plugin)` -- transparent, applies app-wide, already folded
   *   into the root scope;
   * - `app.register(plugin, { prefix: '/api' })` -- encapsulated, so its hooks
   *   live in a child scope the root scope cannot see. Returning only the root
   *   scope (as this used to) meant an identical auth plugin gated
   *   `ws://host/chat` but let `ws://host/api/chat` through with 101 Switching
   *   Protocols, an authentication bypass that differed only by prefix.
   *
   * Omitting `pathname` keeps the old root-only behaviour, for callers that
   * cannot say where the upgrade is aimed.
   */
  getUpgradeHooks(pathname?: string): HookHandler[] {
    if (this.scopes.dirty) this.scopes.flush();
    if (pathname === undefined) return this.rootScope.onRequest;
    return this.onRequestHooksForPath(pathname);
  }

  /**
   * Every `onRequest` hook whose scope covers `pathname`, root-first and
   * de-duplicated by identity.
   *
   * Union rather than a single best-matching scope: two sibling plugins can be
   * registered under the same prefix, and a gate that guessed between them
   * would fail *open* on the one it did not pick. For an unrouted request the
   * conservative answer is to run every guard that could apply.
   */
  private onRequestHooksForPath(pathname: string): HookHandler[] {
    const matched: EncapsulationContext[] = [];
    const visit = (ctx: EncapsulationContext): void => {
      for (const child of ctx.children) {
        // A transparent child adds no prefix of its own, so it is in scope
        // exactly when its parent is, and its hooks are already folded into the
        // parent's resolved scope. Descend anyway: it may have prefixed children.
        if (child.transparent) {
          visit(child);
          continue;
        }
        if (!prefixCoversPath(child.prefix, pathname)) continue;
        matched.push(child);
        visit(child);
      }
    };
    visit(this.rootContext);

    if (matched.length === 0) return this.rootScope.onRequest;

    const hooks: HookHandler[] = [...this.rootScope.onRequest];
    const seen = new Set<HookHandler>(hooks);
    for (const ctx of matched) {
      for (const hook of this.contextScope(ctx).onRequest) {
        if (seen.has(hook)) continue;
        seen.add(hook);
        hooks.push(hook);
      }
    }
    return hooks;
  }

  /**
   * A resolved scope for a context that owns no route of its own, memoized per
   * context. `createContextScope()` registers a binding with the shared
   * registry, so the scope is kept current by the same flush that maintains
   * every route's chain, and creating one per context (not per path) keeps the
   * registry bounded.
   */
  private contextScope(ctx: EncapsulationContext): ResolvedScope {
    let scope = this.pathScopes.get(ctx);
    if (scope === undefined) {
      scope = ctx.createContextScope();
      this.pathScopes.set(ctx, scope);
      this.scopes.flush();
    }
    return scope;
  }

  /**
   * Every `onRequest` hook guarding the routes registered at `pathname`,
   * de-duplicated by identity. Used by the 405 branch, which discloses the set
   * of methods a path accepts and so must be gated by the same hooks the routes
   * themselves are.
   */
  private routeScopeHooks(pathname: string, methods: readonly RouteMethod[]): HookHandler[] {
    const hooks: HookHandler[] = [];
    const seen = new Set<HookHandler>();
    for (const method of methods) {
      let scope: ResolvedScope | undefined;
      try {
        scope = this.router.match(method, pathname)?.route.hooks.onRequest[ROUTE_SCOPE];
      } catch {
        // Malformed URI in a param segment: no scope to contribute.
        continue;
      }
      if (scope === undefined) continue;
      for (const hook of scope.onRequest) {
        if (seen.has(hook)) continue;
        seen.add(hook);
        hooks.push(hook);
      }
    }
    return hooks.length === 0 ? this.rootScope.onRequest : hooks;
  }

  /**
   * How far this app trusts `x-forwarded-*` headers. Read by the WebSocket
   * upgrade gate so a handshake resolves the client's host exactly as an HTTP
   * request does.
   */
  getForwardedTrust(): ForwardedTrustOptions {
    return {
      trustProxy: this.options.trustProxy,
      trustedHosts: this.options.trustedHosts,
      clientIp: this.options.clientIp,
    };
  }

  /**
   * True when the app was created with a real logger (`logger: true` or a
   * logger object) rather than falling back to the silent no-op.
   *
   * `serve()` uses this to decide whether printing a human-readable startup line
   * would corrupt a JSON log stream.
   */
  hasStructuredLogger(): boolean {
    return !this.usingNoopLogger;
  }

  /** Add a named property to every incoming CelsianRequest. */
  decorateRequest(name: PropertyKey, value: unknown): void {
    this.pluginContext.decorateRequest(name, value);
  }

  /** Add a named property to every CelsianReply. */
  decorateReply(name: string, value: unknown): void {
    this.pluginContext.decorateReply(name, value);
  }

  /** Set a custom handler for 404 responses. */
  setNotFoundHandler(handler: RouteHandler): void {
    this.notFoundHandler = handler;
  }

  /** Set a custom error handler that receives thrown errors before the default handler. */
  setErrorHandler(
    handler: (error: Error, request: CelsianRequest, reply: CelsianReply) => Response | Promise<Response>,
  ): void {
    this.errorHandler = handler;
  }

  // ─── Content-Type Parsers ───

  /**
   * Register a custom body parser for a content-type (exact or prefix match).
   *
   * The app's `bodyLimit` is enforced for custom parsers: the body is pre-read
   * through a capped reader (the request is rejected with a 413 HttpError when
   * the limit is exceeded), and the parser receives a Request whose body methods
   * (`text()`, `json()`, `arrayBuffer()`, ...) operate on the already-bounded
   * bytes. Set `bodyLimit: 0` on the app to disable the cap.
   */
  addContentTypeParser(contentType: string, parser: (request: Request) => Promise<unknown>): void {
    this.contentTypeParsers.set(contentType, parser);
  }

  // ─── Task System ───

  /**
   * Register a background task definition.
   *
   * @example
   * ```ts
   * app.task({ name: 'email', handler: async (input) => sendEmail(input), retries: 3 });
   * ```
   */
  task<TInput = unknown>(definition: TaskDefinition<TInput>): void {
    this.taskRegistry.register(definition);
  }

  /**
   * Serverless-safety warning: must stay visible even with the default no-op
   * logger (silent task loss on Lambda otherwise). Falls back to console.warn
   * only when the user supplied no logger; a user-provided logger is respected.
   */
  private safetyWarn(message: string): void {
    this.log.warn(message);
    if (this.usingNoopLogger) {
      console.warn(`[celsian] ${message}`);
    }
  }

  /** Enqueue a background task by name. Returns the task ID. */
  async enqueue(taskName: string, input: unknown): Promise<string> {
    if (!this.taskWorker && !this._enqueuedWithoutWorkerWarned) {
      this.safetyWarn(
        `Task '${taskName}' enqueued but no worker is running. Call app.startWorker() or use serve() to process background tasks.`,
      );
      this._enqueuedWithoutWorkerWarned = true;
    }
    return createEnqueue(this._queue, this.taskRegistry)(taskName, input);
  }

  set queue(backend: QueueBackend) {
    this._queue = backend;
  }

  get queue(): QueueBackend {
    return this._queue;
  }

  /** Configure task worker concurrency and poll interval. */
  setTaskWorkerOptions(options: TaskWorkerOptions): void {
    this.taskWorkerOptions = options;
  }

  /** Start the background task worker (idempotent). */
  startWorker(): void {
    if (this.taskWorker) return;
    this.taskWorker = new TaskWorker(this.taskRegistry, this._queue, this.log, this.taskWorkerOptions);
    this.taskWorker.start();
  }

  /** Stop the task worker and wait for in-flight jobs to finish. */
  async stopWorker(): Promise<void> {
    if (this.taskWorker) {
      await this.taskWorker.stop();
      this.taskWorker = null;
    }
  }

  // ─── Cron ───

  /**
   * Register a cron job with a 5-field unix cron expression.
   *
   * Unix semantics, including the day-field rule: when the day-of-month and
   * day-of-week fields are both restricted, the job runs when EITHER matches.
   * `0 0 13 * 5` is "midnight on the 13th of every month, and every Friday".
   *
   * @example
   * ```ts
   * app.cron('cleanup', '0 3 * * *', async () => { await db.deleteExpired(); });
   * ```
   */
  cron(name: string, schedule: string, handler: () => Promise<void> | void): void {
    this.cronScheduler.add({ name, schedule, handler });
  }

  /** Start the cron scheduler (called automatically by `serve()`). */
  startCron(): void {
    this.cronScheduler.start();
  }

  /** Stop the cron scheduler. */
  stopCron(): void {
    this.cronScheduler.stop();
  }

  /** Return all registered cron job definitions. */
  getCronJobs(): CronJob[] {
    return this.cronScheduler.getJobs();
  }

  // ─── WebSocket ───

  /**
   * Register a WebSocket handler on a path.
   *
   * @example
   * ```ts
   * app.ws('/chat', { open(ws) { ws.send('welcome'); }, message(ws, data) { ... } });
   * ```
   */
  ws(path: string, handler: WSHandler): void {
    this.wsRegistry.register(path, handler);
  }

  /** Broadcast a message to all WebSocket connections on a path. */
  wsBroadcast(path: string, data: string | ArrayBuffer, exclude?: string): void {
    this.wsRegistry.broadcast(path, data, exclude);
  }

  // ─── Health Check ───

  /** Register `/health` and `/ready` endpoints with an optional liveness check. */
  health(options: { path?: string; readyPath?: string; check?: () => Promise<boolean> | boolean } = {}): void {
    const healthPath = options.path ?? "/health";
    const readyPath = options.readyPath ?? "/ready";
    const check = options.check;

    this.get(healthPath, async (_req, reply) => {
      if (check) {
        const ok = await check();
        if (!ok) return reply.status(503).json({ status: "unhealthy" });
      }
      return reply.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    this.get(readyPath, async (_req, reply) => {
      try {
        await this.ready();
        return reply.json({ status: "ready" });
      } catch {
        return reply.status(503).json({ status: "not ready" });
      }
    });
  }

  // ─── Lifecycle ───

  /** Wait for all pending plugin registrations to complete. */
  async ready(): Promise<void> {
    if (!this.readyPromise && this.pendingPlugins.length > 0) {
      const pending = this.pendingPlugins;
      this.pendingPlugins = [];
      this.readyPromise = Promise.all(pending).then(() => {
        this.readyPromise = null;
      });
    }
    if (this.readyPromise) await this.readyPromise;
  }

  // ─── Test Injection ───

  /**
   * Send a synthetic request without starting a server (for testing).
   *
   * @example
   * ```ts
   * const res = await app.inject({ method: 'GET', url: '/hello' });
   * ```
   */
  async inject(options: InjectOptions): Promise<Response> {
    return createInject(this)(options);
  }

  // ─── Request Handling ───

  /** Handle an incoming Web Standard Request and return a Response. */
  handle(request: Request): Promise<Response> {
    // Not an async function: a request that is answered synchronously should
    // cost one resolved promise here, not an async frame and an extra tick.
    try {
      const out = this.dispatch(request);
      return out instanceof Promise ? out.then(toResponse) : Promise.resolve(toResponse(out));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * The request lifecycle behind `handle()` and {@link dispatchRequest}.
   *
   * Answers synchronously whenever nothing on the way is asynchronous: no
   * pending plugin, no body to read, and hooks and a handler that return plain
   * values. The first step that returns a promise makes the rest of the
   * request asynchronous. An error on the synchronous part is thrown, on the
   * asynchronous part it rejects.
   */
  private dispatch(request: Request): Outgoing | Promise<Outgoing> {
    // Ensure all registered plugins are loaded before handling
    if (this.pendingPlugins.length > 0 || this.readyPromise !== null) {
      return this.ready().then(() => this.dispatchReady(request));
    }
    return this.dispatchReady(request);
  }

  private dispatchReady(request: Request): Outgoing | Promise<Outgoing> {
    // Resolve every route's hook chain and decorations from its encapsulation
    // context chain. Only runs when something changed since the last request.
    if (this.scopes.dirty) this.scopes.flush();

    // Serverless safety: warn once if cron jobs registered but scheduler not started
    if (!this._cronNotStartedWarned && this.cronScheduler.getJobs().length > 0 && !this.cronScheduler.isRunning) {
      const count = this.cronScheduler.getJobs().length;
      this.safetyWarn(
        `${count} cron job(s) registered but scheduler not started. In serverless environments, use platform-native cron (Vercel Cron Jobs, AWS EventBridge, CF Cron Triggers) instead of app.cron().`,
      );
      this._cronNotStartedWarned = true;
    }

    // Fast URL parsing: extract pathname and query with simple string ops
    // Avoids new URL() which validates, normalizes, encodes, etc.
    const rawUrl = request.url;
    const method = request.method as import("./types.js").RouteMethod;

    let pathname: string;
    let queryString: string;
    // Bounds of the authority ("host:port") inside rawUrl, -1 for a relative URL.
    let authorityStart = -1;
    let authorityEnd = -1;

    if (rawUrl.charCodeAt(0) === 47 /* '/' */) {
      // Path-only URL (e.g., "/json" or "/json?q=1")
      const qIdx = rawUrl.indexOf("?");
      if (qIdx === -1) {
        pathname = rawUrl;
        queryString = "";
      } else {
        pathname = rawUrl.substring(0, qIdx);
        queryString = rawUrl.substring(qIdx + 1);
      }
    } else {
      // Full URL (e.g., "http://host:port/path?q=1")
      // Extract pathname with string ops: find 3rd '/' (after "http://host")
      let slashCount = 0;
      let pathStart = -1;
      for (let i = 0; i < rawUrl.length; i++) {
        if (rawUrl.charCodeAt(i) === 47 /* '/' */) {
          slashCount++;
          // The two slashes of "://" bracket the authority: it starts here...
          if (slashCount === 2) authorityStart = i + 1;
          if (slashCount === 3) {
            // ...and ends where the path begins.
            pathStart = i;
            break;
          }
        }
      }
      if (pathStart === -1) {
        // No path component (e.g., "http://host"), default to "/"
        pathname = "/";
        queryString = "";
        // "http://host" or "http://host?q" -- the authority runs to the query.
        const markIdx = rawUrl.search(/[?#]/);
        authorityEnd = markIdx === -1 ? rawUrl.length : markIdx;
      } else {
        authorityEnd = pathStart;
        const qIdx = rawUrl.indexOf("?", pathStart);
        if (qIdx === -1) {
          pathname = rawUrl.substring(pathStart);
          queryString = "";
        } else {
          pathname = rawUrl.substring(pathStart, qIdx);
          queryString = rawUrl.substring(qIdx + 1);
        }
      }
    }

    // The URL the *browser* addressed, not the address this process bound to.
    // `serve()` builds `request.url` as `http://${bindHost}:${port}`, so without
    // this the app's own host-sensitive controls (CSRF same-origin, response
    // cache keys, absolute redirects) all compare against `0.0.0.0`. The
    // computed value used to be dropped on the floor: it was passed to
    // `buildRequestFast` as `_fullUrl` and never read.
    //
    // Returns `rawUrl` itself when nothing overrides the transport authority,
    // so the hot path stays allocation-free and `new URL()`-free.
    const effectiveUrl = applyForwardedAuthority(rawUrl, authorityStart, authorityEnd, request.headers, this.options);

    let match: import("./types.js").RouteMatch | null;
    try {
      match = this.router.match(method, pathname);

      // HEAD fallback: try GET handler if no explicit HEAD route
      if (!match && method === "HEAD") {
        match = this.router.match("GET" as import("./types.js").RouteMethod, pathname);
      }
    } catch (matchError) {
      // Malformed URI in a param/wildcard segment (HttpError 400), return a
      // structured error response instead of crashing the request.
      return this.answerMatchError(request, effectiveUrl, matchError);
    }

    if (!match) return this.answerMiss(request, effectiveUrl, pathname);

    // Hooks and decorations that apply to this route, resolved from the chain of
    // encapsulation contexts it was registered in. Attached to the route's own
    // hook array at registration; the fallback covers routes added directly to
    // the router without going through a context.
    const scope = match.route.hooks.onRequest[ROUTE_SCOPE] ?? this.rootScope;

    // Build CelsianRequest with fast query parsing (skip URL object when possible)
    const celsianRequest = buildRequestFast(request, pathname, queryString, match.params, effectiveUrl);
    if (celsianRequest.ip === undefined) celsianRequest.ip = resolveClientIp(request, this.options.clientIp);

    // Apply request decorations (skip loop if none registered)
    if (scope.requestDecorations.size > 0) {
      for (const [key, value] of scope.requestDecorations) {
        if (!(key in celsianRequest)) {
          (celsianRequest as unknown as Record<PropertyKey, unknown>)[key] =
            typeof value === "function" ? value() : value;
        }
      }
    }

    // Only generate requestId and child logger when logging is enabled
    if (this.hasLogger) {
      const requestId = generateRequestId();
      (celsianRequest as Record<string, unknown>).log = this.log.child({ requestId });
      (celsianRequest as Record<string, unknown>).requestId = requestId;
    }

    // Hand the reply the URL *string* and let it parse lazily, and only if a
    // cookie is actually set. The hot path stays free of a `new URL()` call.
    const reply = createReply(effectiveUrl, request.headers);

    // Apply reply decorations (skip loop if none registered)
    if (scope.replyDecorations.size > 0) {
      for (const [key, value] of scope.replyDecorations) {
        if (!(key in reply)) {
          (reply as Record<string, unknown>)[key] = typeof value === "function" ? value() : value;
        }
      }
    }

    return this.respond(celsianRequest, reply, match.route, scope, method === "HEAD", method, pathname);
  }

  /** Answer a request whose path could not even be matched (malformed percent-encoding). */
  private async answerMatchError(request: Request, effectiveUrl: string, matchError: unknown): Promise<Outgoing> {
    const missContext = this.createMissContext(request, effectiveUrl);
    const response = await this.handleError(
      wrapNonError(matchError),
      missContext.request,
      missContext.reply,
      this.rootScope,
    );
    return this.finishMiss(
      await this.applyOnSend(response, missContext.request, missContext.reply, this.rootScope.onSend),
      missContext,
    );
  }

  /** Answer a request that matched no route: a 404, or a 405 when the path exists for other methods. */
  private answerMiss(request: Request, effectiveUrl: string, pathname: string): Outgoing | Promise<Outgoing> {
    const missContext = this.createMissContext(request, effectiveUrl);

    // Distinguish 404 (path not found) from 405 (wrong method)
    const isMethodMismatch = this.router.hasPath(pathname);
    // RFC 9110 makes `Allow` mandatory on a 405. Without it the client is
    // told its method is wrong but never which ones would work, and
    // `docs/errors.md` promised the header while nothing in core ever set it.
    const allowed = isMethodMismatch ? this.router.allowedMethods(pathname) : [];

    // A 405 enumerates the methods a path accepts, so it is a disclosure and
    // has to clear the same gate the path's routes do. Running only the root
    // scope listed `GET, HEAD, PUT, DELETE` for `/admin/users/1` behind an
    // encapsulated auth guard that answered 401 to every real request.
    //
    // A 404 has no route to resolve a scope from, so it takes the same union
    // of every guard covering the path that an unrouted WebSocket upgrade
    // does. Running only the root scope let a custom `setNotFoundHandler`
    // answer `/admin/nonexistent` without the `{ prefix: '/admin' }` guard
    // ever seeing the request, while the identical un-prefixed guard ran.
    const missHooks =
      allowed.length > 0 ? this.routeScopeHooks(pathname, allowed) : this.onRequestHooksForPath(pathname);
    if (missHooks.length > 0) {
      const early = runHooksUntilAnswer(missHooks, missContext.request, missContext.reply);
      if (early instanceof Promise) {
        return early.then((answer) =>
          answer !== null
            ? this.finishMiss(mergeReply(answer, missContext.reply, null), missContext)
            : this.answerMissUnhooked(missContext, isMethodMismatch, allowed),
        );
      }
      if (early !== null) return this.finishMiss(mergeReply(early, missContext.reply, null), missContext);
    }
    return this.answerMissUnhooked(missContext, isMethodMismatch, allowed);
  }

  /** {@link answerMiss} once the guards covering the path have let the request through. */
  private answerMissUnhooked(
    missContext: { request: CelsianRequest; reply: CelsianReply },
    isMethodMismatch: boolean,
    allowed: RouteMethod[],
  ): Outgoing | Promise<Outgoing> {
    if (isMethodMismatch) {
      // The built-in miss answers are fast responses, like any other JSON
      // body: one write on Node instead of a stream drain.
      const r405 = fastResponse(
        CelsianApp.METHOD_NOT_ALLOWED_BODY,
        405,
        allowed.length > 0
          ? { ...CelsianApp.JSON_CONTENT_TYPE, allow: allowed.join(", ") }
          : { ...CelsianApp.JSON_CONTENT_TYPE },
      );
      return this.sendMiss(r405, missContext);
    }
    if (this.notFoundHandler) return this.answerWithNotFoundHandler(this.notFoundHandler, missContext);
    const r404 = fastResponse(CelsianApp.NOT_FOUND_BODY, 404, { ...CelsianApp.JSON_CONTENT_TYPE });
    return this.sendMiss(r404, missContext);
  }

  private async answerWithNotFoundHandler(
    notFoundHandler: RouteHandler,
    missContext: { request: CelsianRequest; reply: CelsianReply },
  ): Promise<Outgoing> {
    try {
      const result = await notFoundHandler(missContext.request, missContext.reply);
      if (result instanceof Response) {
        return this.finishMiss(
          await this.applyOnSend(result, missContext.request, missContext.reply, this.rootScope.onSend),
          missContext,
        );
      }
      const empty = new Response(null, { status: missContext.reply.sent ? missContext.reply.statusCode : 404 });
      return this.finishMiss(mergeReply(empty, missContext.reply, null), missContext);
    } catch (error) {
      if (this.hasLogger) {
        this.log.error("notFound handler error", {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        console.error("[celsian]", error);
      }
      const r404 = fastResponse(CelsianApp.NOT_FOUND_BODY, 404, { ...CelsianApp.JSON_CONTENT_TYPE });
      return this.finishMiss(
        await this.applyOnSend(r404, missContext.request, missContext.reply, this.rootScope.onSend),
        missContext,
      );
    }
  }

  /** Run the root onSend chain over a miss response and hand it to onResponse. */
  private sendMiss(
    response: Response,
    missContext: { request: CelsianRequest; reply: CelsianReply },
  ): Outgoing | Promise<Outgoing> {
    const sent = this.applyOnSend(response, missContext.request, missContext.reply, this.rootScope.onSend);
    if (sent instanceof Promise) return sent.then((out) => this.finishMiss(out, missContext));
    return this.finishMiss(sent, missContext);
  }

  /**
   * Run a matched route and turn whatever happens into the response to send:
   * the lifecycle's own answer, or the error path's when it throws or times out.
   */
  private respond(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
    scope: ResolvedScope,
    isHead: boolean,
    method: string,
    pathname: string,
  ): Outgoing | Promise<Outgoing> {
    // Auto request logging
    let trace: RequestTrace | null = null;
    if (this.hasLogger) {
      const requestId = (request as Record<string, unknown>).requestId as string;
      trace = { method, pathname, requestId, start: performance.now() };
      this.log.info("incoming request", { method, url: pathname, requestId });
    }

    // From here until the lifecycle settles, the timeout may abort
    // `request.signal`. The signal itself is only built if something reads it.
    const timeout = this.cachedRequestTimeout;
    let started = 0;
    if (timeout > 0) {
      armRequestTimeout(request);
      started = performance.now();
    }

    let out: Outgoing | Promise<Outgoing>;
    try {
      out = this.runLifecycle(request, reply, route, scope);
    } catch (thrown) {
      if (timeout > 0) disarmRequestTimeout(request);
      return this.recover(thrown, request, reply, scope, isHead, trace);
    }
    if (!(out instanceof Promise)) {
      // Answered synchronously. A timer could not have interrupted that, so
      // none was ever set.
      if (timeout > 0) disarmRequestTimeout(request);
      return this.complete(out, request, reply, scope, isHead, trace);
    }
    if (timeout <= 0) {
      return out.then(
        (settled) => this.complete(settled, request, reply, scope, isHead, trace),
        (thrown) => this.recover(thrown, request, reply, scope, isHead, trace),
      );
    }

    // Hooks and a handler that worked synchronously before the first
    // asynchronous step have used part of the timeout already. Usually that is
    // nothing, and then the timer gets the configured duration itself: Node
    // keeps timers of one duration in one list, so a server's request timeouts
    // all share it. Otherwise it gets what is left, rounded up so that it never
    // fires before the deadline.
    //
    // Past the deadline already, no timer can be early enough. A timer set at
    // the start of the request, as it used to be, would be due by now and
    // would fire before any timer the handler set on its way here, so a
    // handler that awaits one got the 504. A timer set now would be due after
    // those. So the 504 comes once the microtask queue has drained instead
    // (`remaining` 0, see settleWithin): a lifecycle that settles without
    // waiting on anything still answers first, as it did before a timer set at
    // the start could fire, and one that waits on anything is answered 504
    // before what it waits on can run. (Off Node, a lifecycle that would have
    // settled on microtasks alone may get the 504 as well: it is past its
    // deadline either way. Without process.nextTick, a 1 ms timer as before.)
    const elapsed = performance.now() - started;
    const remaining =
      elapsed < 1
        ? timeout
        : elapsed >= timeout && afterMicrotasks !== undefined
          ? 0
          : Math.max(1, Math.ceil(timeout - elapsed));
    return this.settleWithin(out, remaining, request, reply, scope, isHead, trace);
  }

  /**
   * The answer to a lifecycle that went asynchronous, with `remaining` ms of
   * the request timeout left: the lifecycle's own if it settles in time, a 504
   * through the error path if not. `remaining` 0 means the deadline has
   * passed already: the 504 comes once the microtask queue has drained, unless
   * the lifecycle settled by then (see respond).
   *
   * One timer, cleared by whichever way the lifecycle settles, and one
   * promise. The lifecycle is watched once, and that same callback finishes
   * the response (`complete`, or `recover` for a throw) instead of handing it
   * through a second promise to do so. When the timeout wins, the lifecycle
   * keeps running and its eventual result, or rejection, is dropped.
   */
  private settleWithin(
    pending: Promise<Outgoing>,
    remaining: number,
    request: CelsianRequest,
    reply: CelsianReply,
    scope: ResolvedScope,
    isHead: boolean,
    trace: RequestTrace | null,
  ): Promise<Outgoing> {
    return new Promise<Outgoing>((resolve, reject) => {
      // Whichever comes first, the lifecycle or the timeout, ends the other's say.
      let timedOut = false;
      let settled = false;
      const onTimeout = () => {
        if (settled) return;
        timedOut = true;
        try {
          // Aborted (in addition to answering 504) so in-flight work can stop promptly.
          fireRequestTimeout(request, new HttpError(504, "Gateway Timeout"));
          resolve(this.recover(new HttpError(504, "Gateway Timeout"), request, reply, scope, isHead, trace));
        } catch (failure) {
          reject(failure);
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (remaining > 0) timer = setTimeout(onTimeout, remaining);
      else (afterMicrotasks as (callback: () => void) => void)(onTimeout);
      pending.then(
        (outgoing) => {
          if (timedOut) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          disarmRequestTimeout(request);
          try {
            resolve(this.complete(outgoing, request, reply, scope, isHead, trace));
          } catch (failure) {
            reject(failure);
          }
        },
        (thrown) => {
          if (timedOut) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          disarmRequestTimeout(request);
          try {
            resolve(this.recover(thrown, request, reply, scope, isHead, trace));
          } catch (failure) {
            reject(failure);
          }
        },
      );
    });
  }

  /** The lifecycle answered: log it and hand the response to onResponse. */
  private complete(
    response: Outgoing,
    request: CelsianRequest,
    reply: CelsianReply,
    scope: ResolvedScope,
    isHead: boolean,
    trace: RequestTrace | null,
  ): Outgoing | Promise<Outgoing> {
    try {
      if (isHead) response = headOf(response);
      if (trace !== null) {
        const duration = Math.round(performance.now() - trace.start);
        this.log.info("request completed", {
          method: trace.method,
          url: trace.pathname,
          statusCode: response.status,
          duration,
          requestId: trace.requestId,
        });
      }
      return this.finish(response, request, reply, scope.onResponse);
    } catch (thrown) {
      return this.recover(thrown, request, reply, scope, isHead, trace);
    }
  }

  /** The lifecycle threw, rejected or timed out: answer through the error handlers and onSend. */
  private recover(
    thrown: unknown,
    request: CelsianRequest,
    reply: CelsianReply,
    scope: ResolvedScope,
    isHead: boolean,
    trace: RequestTrace | null,
  ): Outgoing | Promise<Outgoing> {
    const error = wrapNonError(thrown);
    const handled = this.handleError(error, request, reply, scope);
    if (handled instanceof Promise) {
      return handled.then((response) => this.recoverWith(response, error, request, reply, scope, isHead, trace));
    }
    return this.recoverWith(handled, error, request, reply, scope, isHead, trace);
  }

  private recoverWith(
    handled: Response,
    error: Error,
    request: CelsianRequest,
    reply: CelsianReply,
    scope: ResolvedScope,
    isHead: boolean,
    trace: RequestTrace | null,
  ): Outgoing | Promise<Outgoing> {
    const sent = this.applyOnSend(handled, request, reply, scope.onSend);
    if (sent instanceof Promise) {
      return sent.then((response) => this.finishRecovered(response, error, request, reply, scope, isHead, trace));
    }
    return this.finishRecovered(sent, error, request, reply, scope, isHead, trace);
  }

  private finishRecovered(
    response: Outgoing,
    error: Error,
    request: CelsianRequest,
    reply: CelsianReply,
    scope: ResolvedScope,
    isHead: boolean,
    trace: RequestTrace | null,
  ): Outgoing {
    if (isHead) response = headOf(response);
    if (trace !== null) {
      const duration = Math.round(performance.now() - trace.start);
      this.log.error("request error", {
        method: trace.method,
        url: trace.pathname,
        statusCode: response.status,
        duration,
        requestId: trace.requestId,
        error: error.message,
      });
    }
    return this.finish(response, request, reply, scope.onResponse);
  }

  /**
   * `handle` as a standalone fetch handler, for `Bun.serve`, `Deno.serve` and
   * Workers. The runtime's second argument is read for the peer address that
   * becomes `request.ip`: Bun's server (`requestIP()`) or Deno's handler info
   * (`remoteAddr`). Any other second argument is ignored.
   */
  get fetch(): (request: Request, context?: unknown) => Promise<Response> {
    return (request, context) =>
      this.handle(
        context === undefined ? request : setRemoteAddress(request, remoteAddressFromServeContext(request, context)),
      );
  }

  /** Return all registered routes, optionally filtered by deployment kind. */
  getRoutes(filter?: { kind?: "serverless" | "hot" | "task" }): InternalRoute[] {
    const routes = this.router.getAllRoutes();
    if (filter?.kind) {
      return routes.filter((r) => r.kind === filter.kind);
    }
    return routes;
  }

  /**
   * Export route manifest for deployment tooling.
   * Returns a JSON-serializable array of route metadata grouped by kind.
   */
  getRouteManifest(): { serverless: RouteManifestEntry[]; hot: RouteManifestEntry[]; task: RouteManifestEntry[] } {
    const routes = this.router.getAllRoutes();
    const manifest = {
      serverless: [] as RouteManifestEntry[],
      hot: [] as RouteManifestEntry[],
      task: [] as RouteManifestEntry[],
    };
    for (const r of routes) {
      const bucket = manifest[r.kind as keyof typeof manifest];
      if (bucket) bucket.push({ method: r.method, url: r.url, kind: r.kind });
    }
    return manifest;
  }

  // ─── Internal ───

  // The lifecycle, one method per stretch between two steps that may be
  // asynchronous. Each runs straight through into the next while its hooks
  // return plain values, and hands the rest to a `.then()` the moment one
  // returns a promise. So a request costs promises in proportion to the
  // asynchronous work it actually does, and a fully synchronous one costs none.

  private runLifecycle(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
    scope: ResolvedScope,
  ): Outgoing | Promise<Outgoing> {
    // 1. onRequest hooks (skip if empty)
    if (scope.onRequest.length > 0) {
      const early = runHooksUntilAnswer(scope.onRequest, request, reply);
      if (early instanceof Promise) {
        return early.then((answer) =>
          answer !== null ? mergeReply(answer, reply, null) : this.runFromPreParsing(request, reply, route, scope),
        );
      }
      if (early !== null) return mergeReply(early, reply, null);
    }
    return this.runFromPreParsing(request, reply, route, scope);
  }

  private runFromPreParsing(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
    scope: ResolvedScope,
  ): Outgoing | Promise<Outgoing> {
    // 2. preParsing hooks (skip if empty)
    if (scope.preParsing.length > 0) {
      const early = runHooksUntilAnswer(scope.preParsing, request, reply);
      if (early instanceof Promise) {
        return early.then((answer) =>
          answer !== null ? mergeReply(answer, reply, null) : this.runFromParsing(request, reply, route, scope),
        );
      }
      if (early !== null) return mergeReply(early, reply, null);
    }
    return this.runFromParsing(request, reply, route, scope);
  }

  private runFromParsing(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
    scope: ResolvedScope,
  ): Outgoing | Promise<Outgoing> {
    // 3. Body parsing. `undefined` means there was nothing to read.
    const parsing = parseBodyIfAny(request, this.cachedBodyLimit, this.contentTypeParsers);
    if (parsing !== undefined) return parsing.then(() => this.runFromPreValidation(request, reply, route, scope));
    return this.runFromPreValidation(request, reply, route, scope);
  }

  private runFromPreValidation(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
    scope: ResolvedScope,
  ): Outgoing | Promise<Outgoing> {
    // 4. preValidation hooks (skip if empty)
    if (scope.preValidation.length > 0) {
      const early = runHooksUntilAnswer(scope.preValidation, request, reply);
      if (early instanceof Promise) {
        return early.then((answer) =>
          answer !== null ? mergeReply(answer, reply, null) : this.runFromValidation(request, reply, route, scope),
        );
      }
      if (early !== null) return mergeReply(early, reply, null);
    }
    return this.runFromValidation(request, reply, route, scope);
  }

  private runFromValidation(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
    scope: ResolvedScope,
  ): Outgoing | Promise<Outgoing> {
    // 5. Schema validation
    if (route.schema) {
      this.validateRequest(request, route);
    }

    // 6. preHandler hooks (skip if empty)
    if (scope.preHandler.length > 0) {
      const early = runHooksUntilAnswer(scope.preHandler, request, reply);
      if (early instanceof Promise) {
        return early.then((answer) =>
          answer !== null ? mergeReply(answer, reply, null) : this.runHandler(request, reply, route, scope),
        );
      }
      if (early !== null) return mergeReply(early, reply, null);
    }
    return this.runHandler(request, reply, route, scope);
  }

  private runHandler(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
    scope: ResolvedScope,
  ): Outgoing | Promise<Outgoing> {
    // 7. Handler
    const handlerResult = route.handler(request, reply);
    if (isThenable(handlerResult)) {
      return toPromise(handlerResult).then((settled) => this.runFromResult(settled, request, reply, route, scope));
    }
    return this.runFromResult(handlerResult, request, reply, route, scope);
  }

  private runFromResult(
    handlerResult: unknown,
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
    scope: ResolvedScope,
  ): Outgoing | Promise<Outgoing> {
    let response: Outgoing;

    if (handlerResult instanceof Response) {
      response = handlerResult;
    } else if (reply.sent) {
      response = new Response(null, { status: reply.statusCode });
    } else if (handlerResult !== null && handlerResult !== undefined) {
      // Auto-serialize non-Response return values (strings → text, objects → JSON)
      if (typeof handlerResult === "string") {
        response = fastResponse(
          handlerResult,
          reply.statusCode || 200,
          { "content-type": "text/plain; charset=utf-8", ...reply.headers },
          replyCookies(reply) as string[],
        );
      } else {
        response = fastResponse(
          JSON.stringify(handlerResult),
          reply.statusCode || 200,
          { "content-type": "application/json; charset=utf-8", ...reply.headers },
          replyCookies(reply) as string[],
        );
      }
    } else {
      response = new Response(null, { status: 204 });
    }

    // Headers and cookies set on the reply belong on the response however the
    // handler finished. The reply helpers and the serializer above already
    // wrote them, so this only changes a Response the handler built itself.
    response = mergeReply(response, reply, null);

    // 8. Response schema validation (only for routes that declare schema.response)
    if (route.schema?.response && this.responseValidationEnabled) {
      response = this.validateResponse(response, handlerResult, route);
    }

    // 9. preSerialization hooks (skip if empty)
    if (scope.preSerialization.length > 0) {
      const pending = runHooksUntilAnswer(scope.preSerialization, request, reply);
      if (pending instanceof Promise) {
        const built = response;
        return pending.then(() => this.runOnSend(built, request, reply, scope.onSend));
      }
    }

    // 10. onSend hooks, the resolved chain already runs root → plugin → route.
    // onResponse runs in `respond()`, once the final response is known, so it
    // also covers early returns, errors and timeouts.
    return this.runOnSend(response, request, reply, scope.onSend);
  }

  /**
   * Run an onSend chain and put whatever it set on the reply onto the response.
   * The hooks are shown the status that will actually be sent.
   */
  private runOnSend(
    response: Outgoing,
    request: CelsianRequest,
    reply: CelsianReply,
    hooks: HookHandler[],
  ): Outgoing | Promise<Outgoing> {
    reply.statusCode = response.status;
    if (hooks.length === 0) return response;
    const shown = { ...reply.headers };
    let pending: Promise<void> | undefined;
    try {
      pending = runOnSendHooksNow(hooks, request, reply);
    } catch (err) {
      this.log.error("onSend hook error", { error: err instanceof Error ? err.message : String(err) });
      return response;
    }
    if (pending !== undefined) {
      return pending.then(
        () => mergeReply(response, reply, shown),
        (err) => {
          this.log.error("onSend hook error", { error: err instanceof Error ? err.message : String(err) });
          return response;
        },
      );
    }
    return mergeReply(response, reply, shown);
  }

  private createMissContext(request: Request, effectiveUrl: string): { request: CelsianRequest; reply: CelsianReply } {
    const fullUrl = new URL(effectiveUrl, "http://localhost");
    const celsianRequest = buildRequest(request, fullUrl, {});
    if (celsianRequest.ip === undefined) celsianRequest.ip = resolveClientIp(request, this.options.clientIp);
    const reply = createReply(fullUrl, request.headers);
    if (this.rootScope.replyDecorations.size > 0) {
      for (const [key, value] of this.rootScope.replyDecorations) {
        (reply as Record<string, unknown>)[key] = typeof value === "function" ? value() : value;
      }
    }
    return { request: celsianRequest, reply };
  }

  /** Run an already-resolved onSend chain against a response built outside the normal lifecycle. */
  private applyOnSend(
    response: Outgoing,
    request: CelsianRequest,
    reply: CelsianReply,
    hooks: HookHandler[],
  ): Outgoing | Promise<Outgoing> {
    return this.runOnSend(mergeReply(response, reply, null), request, reply, hooks);
  }

  /**
   * Hand the final response to `onResponse`. `reply.statusCode` is set to the
   * status actually sent first: a Response built by a handler, an error handler
   * or an early-returning hook never went through `reply.status()`.
   */
  private finish(response: Outgoing, request: CelsianRequest, reply: CelsianReply, hooks: HookHandler[]): Outgoing {
    reply.statusCode = response.status;
    if (hooks.length > 0) runHooksFireAndForget(hooks, request, reply, this.log);
    return response;
  }

  /** {@link finish} for a request that matched no route, which runs the root scope's hooks. */
  private finishMiss(response: Outgoing, context: { request: CelsianRequest; reply: CelsianReply }): Outgoing {
    return this.finish(response, context.request, context.reply, this.rootScope.onResponse);
  }

  private validateRequest(request: CelsianRequest, route: InternalRoute): void {
    const schema = route.schema;
    if (!schema) return;
    // Adapters built when the route was registered, see route-validators.ts.
    const validators = (route as RouteWithValidators)[ROUTE_VALIDATORS];

    if (schema.body) {
      const bodySchema: StandardSchema = validatorFor(validators?.body, schema.body);
      const result = bodySchema.validate(request.parsedBody);
      if (!result.success) {
        throw new ValidationError(result.issues ?? []);
      }
      request.parsedBody = result.data;
    }

    if (schema.querystring) {
      const querySchema: StandardSchema = validatorFor(validators?.querystring, schema.querystring);
      const result = querySchema.validate(request.query);
      if (!result.success) {
        throw new ValidationError(result.issues ?? []);
      }
      // Write the validated output back to `request.query` too, reading the
      // ergonomic property must never hand back the raw, uncoerced input.
      // `parsedQuery` stays as an alias for the explicitly-typed accessor.
      const validatedQuery = result.data as Record<string, string | string[]>;
      request.query = validatedQuery;
      (request as Record<string, unknown>).parsedQuery = validatedQuery;
    }

    if (schema.params) {
      const paramsSchema: StandardSchema = validatorFor(validators?.params, schema.params);
      const result = paramsSchema.validate(request.params);
      if (!result.success) {
        throw new ValidationError(result.issues ?? []);
      }
      request.params = result.data as Record<string, string>;
    }
  }

  /**
   * Validate a response against the route's `schema.response` entry for its
   * status code (falling back to a `default` entry).
   *
   * A mismatch is a server bug, not a client one: the caller gets a generic 500
   * and the offending payload is only ever written to the server-side log.
   * Disable with `createApp({ validateResponses: false })`.
   */
  private validateResponse(response: Outgoing, handlerResult: unknown, route: InternalRoute): Outgoing {
    const schemas = route.schema?.response;
    if (!schemas) return response;

    // Accepts both `{ 200: schema }` and a bare schema (2xx only). See
    // `resolveResponseSchema` for why the `default` lookup needs Object.hasOwn.
    const responseSchema = resolveResponseSchema(schemas, response.status);
    if (responseSchema === undefined || responseSchema === null) return response;

    let payload: unknown;
    if (handlerResult !== null && handlerResult !== undefined && !(handlerResult instanceof Response)) {
      // Auto-serialized return value, validate it before it was stringified.
      payload = handlerResult;
    } else {
      // The handler built its own Response (reply.json(...), reply.send(...)).
      const wire = response instanceof WireResponse ? response : null;
      const contentType = wire ? wire.headers["content-type"] : peekHeaders(response as Response).get("content-type");
      if (!(contentType ?? "").includes("json")) return response;

      // Only a body that was already serialized in memory may be read here.
      // `response.clone().json()` looks harmless but it TEES the body stream and
      // drains it to completion, so a live `reply.stream()` of NDJSON or
      // progressive JSON was fully buffered before the client saw its first
      // byte, and an endless stream hung until the request timeout fired a 504.
      // A response carrying a fast payload was built from a string or a byte
      // array, so parsing that payload reads no stream at all.
      const body = wire ? wire.body : getFastPayload(response as Response)?.body;
      if (body === undefined || body === null) return response;
      try {
        payload = JSON.parse(typeof body === "string" ? body : RESPONSE_DECODER.decode(body));
      } catch {
        // Body is not JSON after all, nothing to check.
        return response;
      }
    }

    const result = responseValidatorFor((route as RouteWithValidators)[ROUTE_VALIDATORS], responseSchema).validate(
      payload,
    );
    if (result.success) return response;

    const detail = {
      method: route.method,
      url: route.url,
      statusCode: response.status,
      issues: result.issues ?? [],
    };
    this.log.error("response schema validation failed", detail);
    if (this.usingNoopLogger) {
      console.error("[celsian] response schema validation failed", detail);
    }
    return fastResponse(CelsianApp.RESPONSE_VALIDATION_BODY, 500, { ...CelsianApp.JSON_CONTENT_TYPE });
  }

  private handleError(
    error: Error,
    request: CelsianRequest,
    reply: CelsianReply,
    scope: ResolvedScope,
  ): Response | Promise<Response> {
    return handleErrorNow(error, request, reply, this.errorHandler, scope.onError, this.hasLogger ? this.log : null);
  }
}

/**
 * Create a new CelsianJS application.
 *
 * @example
 * ```ts
 * const app = createApp({ logger: true });
 * app.get('/hello', (req, reply) => reply.json({ message: 'Hello!' }));
 * serve(app, { port: 3000 });
 * ```
 */
export function createApp(options?: CelsianAppOptions): CelsianApp {
  return new CelsianApp(options);
}
