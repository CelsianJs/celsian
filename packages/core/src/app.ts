// @celsian/core, CelsianApp: hook-based server with plugin encapsulation

import { fromSchema, type InferOutput, type StandardSchema } from "@celsian/schema";
import { parseBody } from "./body-parser.js";
import { EncapsulationContext, type ScopeRegistry } from "./context.js";
import { parseCookies } from "./cookie.js";
import { type CronJob, CronScheduler } from "./cron.js";
import { handleError as handleErrorFn } from "./error-handler.js";
import { assertPlugin, CelsianError, HttpError, ValidationError, wrapNonError } from "./errors.js";
import { fastResponse, getFastPayload } from "./fast-response.js";
import { runHooks, runHooksFireAndForget, runOnSendHooks } from "./hooks.js";
import { createInject, type InjectOptions } from "./inject.js";
import { createLogger, generateRequestId, type Logger } from "./logger.js";
import { MemoryQueue, type QueueBackend } from "./queue.js";
import { createReply } from "./reply.js";
import { applyForwardedAuthority, buildRequest, buildRequestFast, type ForwardedTrustOptions } from "./request.js";
import { resolveResponseSchema } from "./response-schema.js";
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
    return { trustProxy: this.options.trustProxy, trustedHosts: this.options.trustedHosts };
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
  async handle(request: Request): Promise<Response> {
    // Ensure all registered plugins are loaded before handling
    // Skip the async call entirely when no pending plugins and no active ready promise
    if (this.pendingPlugins.length > 0 || this.readyPromise !== null) {
      await this.ready();
    }

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
      const missContext = await this.createMissContext(request, effectiveUrl);
      const response = await this.handleError(
        wrapNonError(matchError),
        missContext.request,
        missContext.reply,
        this.rootScope,
      );
      return this.applyOnSend(response, missContext.request, missContext.reply, this.rootScope.onSend);
    }

    if (!match) {
      const missContext = await this.createMissContext(request, effectiveUrl);

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
      const earlyResponse = await runHooks(missHooks, missContext.request, missContext.reply);
      if (earlyResponse) return earlyResponse;
      const missHeaders = this.mergeReplyHeaders(CelsianApp.JSON_CONTENT_TYPE, missContext.reply);

      if (isMethodMismatch) {
        if (allowed.length > 0) missHeaders.set("allow", allowed.join(", "));
        const r405 = new Response(CelsianApp.METHOD_NOT_ALLOWED_BODY, {
          status: 405,
          headers: missHeaders,
        });
        return this.applyOnSend(r405, missContext.request, missContext.reply, this.rootScope.onSend);
      }
      if (this.notFoundHandler) {
        try {
          const result = await this.notFoundHandler(missContext.request, missContext.reply);
          if (result instanceof Response)
            return this.applyOnSend(result, missContext.request, missContext.reply, this.rootScope.onSend);
          if (missContext.reply.sent) return new Response(null, { status: missContext.reply.statusCode });
          return new Response(null, { status: 404 });
        } catch (error) {
          if (this.hasLogger) {
            this.log.error("notFound handler error", {
              error: error instanceof Error ? error.message : String(error),
            });
          } else {
            console.error("[celsian]", error);
          }
          const r404 = new Response(CelsianApp.NOT_FOUND_BODY, {
            status: 404,
            headers: missHeaders,
          });
          return this.applyOnSend(r404, missContext.request, missContext.reply, this.rootScope.onSend);
        }
      }
      const r404 = new Response(CelsianApp.NOT_FOUND_BODY, {
        status: 404,
        headers: missHeaders,
      });
      return this.applyOnSend(r404, missContext.request, missContext.reply, this.rootScope.onSend);
    }

    // Hooks and decorations that apply to this route, resolved from the chain of
    // encapsulation contexts it was registered in. Attached to the route's own
    // hook array at registration; the fallback covers routes added directly to
    // the router without going through a context.
    const scope = match.route.hooks.onRequest[ROUTE_SCOPE] ?? this.rootScope;

    // Build CelsianRequest with fast query parsing (skip URL object when possible)
    const celsianRequest = buildRequestFast(request, pathname, queryString, match.params, effectiveUrl);

    // Apply request decorations (skip loop if none registered)
    if (scope.requestDecorations.size > 0) {
      for (const [key, value] of scope.requestDecorations) {
        if (!(key in celsianRequest)) {
          (celsianRequest as unknown as Record<PropertyKey, unknown>)[key] =
            typeof value === "function" ? value() : value;
        }
      }
    }

    // Lazy cookie parsing
    let parsedCookies: Record<string, string> | null = null;
    Object.defineProperty(celsianRequest, "cookies", {
      get: () => {
        if (!parsedCookies) {
          parsedCookies = parseCookies(request.headers.get("cookie") ?? "");
        }
        return parsedCookies;
      },
      configurable: true,
      enumerable: true,
    });

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

    // Run lifecycle, inline timeout logic to avoid closure allocation
    const timeout = this.cachedRequestTimeout;
    const isHead = method === "HEAD";

    // Auto request logging
    if (this.hasLogger) {
      const requestId = (celsianRequest as Record<string, unknown>).requestId as string;
      const start = performance.now();
      this.log.info("incoming request", { method, url: pathname, requestId });

      try {
        let response = await this.runWithTimeout(celsianRequest, reply, match.route, scope, timeout);
        if (isHead) response = new Response(null, { status: response.status, headers: response.headers });
        const duration = Math.round(performance.now() - start);
        this.log.info("request completed", { method, url: pathname, statusCode: response.status, duration, requestId });
        return response;
      } catch (thrown) {
        const error = wrapNonError(thrown);
        let response = await this.handleError(error, celsianRequest, reply, scope);
        response = await this.applyOnSend(response, celsianRequest, reply, scope.onSend);
        if (isHead) response = new Response(null, { status: response.status, headers: response.headers });
        const duration = Math.round(performance.now() - start);
        this.log.error("request error", {
          method,
          url: pathname,
          statusCode: response.status,
          duration,
          requestId,
          error: error.message,
        });
        return response;
      }
    }

    try {
      let response = await this.runWithTimeout(celsianRequest, reply, match.route, scope, timeout);
      if (isHead) response = new Response(null, { status: response.status, headers: response.headers });
      return response;
    } catch (thrown) {
      let response = await this.handleError(wrapNonError(thrown), celsianRequest, reply, scope);
      response = await this.applyOnSend(response, celsianRequest, reply, scope.onSend);
      if (isHead) response = new Response(null, { status: response.status, headers: response.headers });
      return response;
    }
  }

  /** Bound `handle` method, compatible with Bun.serve and Deno.serve. */
  get fetch(): (request: Request) => Promise<Response> {
    return this.handle.bind(this);
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

  /**
   * Run the request lifecycle with an optional timeout.
   */
  private runWithTimeout(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
    scope: ResolvedScope,
    timeout: number,
  ): Promise<Response> {
    if (timeout <= 0) {
      return this.runLifecycle(request, reply, route, scope);
    }
    // Per-request AbortController: exposed as request.signal so handlers can
    // observe cancellation, and aborted when the timeout fires (in addition to
    // rejecting with 504) so in-flight work can stop promptly.
    const controller = new AbortController();
    (request as Record<string, unknown>).signal = controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      this.runLifecycle(request, reply, route, scope).finally(() => clearTimeout(timer)),
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new HttpError(504, "Gateway Timeout"));
          reject(new HttpError(504, "Gateway Timeout"));
        }, timeout);
      }),
    ]);
  }

  private async runLifecycle(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
    scope: ResolvedScope,
  ): Promise<Response> {
    let earlyResponse: Response | null;

    // 1. onRequest hooks (skip if empty)
    if (scope.onRequest.length > 0) {
      earlyResponse = await runHooks(scope.onRequest, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 2. preParsing hooks (skip if empty)
    if (scope.preParsing.length > 0) {
      earlyResponse = await runHooks(scope.preParsing, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 3. Body parsing
    await this.parseBody(request);

    // 4. preValidation hooks (skip if empty)
    if (scope.preValidation.length > 0) {
      earlyResponse = await runHooks(scope.preValidation, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 5. Schema validation
    if (route.schema) {
      this.validateRequest(request, route.schema);
    }

    // 6. preHandler hooks (skip if empty)
    if (scope.preHandler.length > 0) {
      earlyResponse = await runHooks(scope.preHandler, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 7. Handler
    const handlerResult = await route.handler(request, reply);
    let response: Response;

    if (handlerResult instanceof Response) {
      response = handlerResult;
    } else if (reply.sent) {
      response = new Response(null, { status: reply.statusCode });
    } else if (handlerResult !== null && handlerResult !== undefined) {
      // Auto-serialize non-Response return values (strings → text, objects → JSON)
      if (typeof handlerResult === "string") {
        response = fastResponse(handlerResult, reply.statusCode || 200, {
          "content-type": "text/plain; charset=utf-8",
          ...reply.headers,
        });
      } else {
        response = fastResponse(JSON.stringify(handlerResult), reply.statusCode || 200, {
          "content-type": "application/json; charset=utf-8",
          ...reply.headers,
        });
      }
    } else {
      response = new Response(null, { status: 204 });
    }

    // 8. Response schema validation (only for routes that declare schema.response)
    if (route.schema?.response && this.responseValidationEnabled) {
      response = await this.validateResponse(response, handlerResult, route);
    }

    // 9. preSerialization hooks (skip if empty)
    if (scope.preSerialization.length > 0) {
      await runHooks(scope.preSerialization, request, reply);
    }

    // 10. onSend hooks, the resolved chain already runs root → plugin → route
    if (scope.onSend.length > 0) {
      const headersBefore = new Map<string, string>();
      for (const [k, v] of Object.entries(reply.headers)) {
        headersBefore.set(k, v);
      }

      try {
        await runOnSendHooks(scope.onSend, request, reply);
      } catch (err) {
        this.log.error("onSend hook error", { error: err instanceof Error ? err.message : String(err) });
        return response;
      }

      const replyHeaders = reply.headers;
      let needsMerge = false;
      for (const [k, v] of Object.entries(replyHeaders)) {
        if (headersBefore.get(k) !== v) {
          needsMerge = true;
          break;
        }
      }
      if (needsMerge) {
        const mergedHeaders = new Headers(response.headers);
        for (const [k, v] of Object.entries(replyHeaders)) {
          if (headersBefore.get(k) !== v) {
            mergedHeaders.set(k, v);
          }
        }
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: mergedHeaders,
        });
      }
    }

    // 11. onResponse hooks (fire-and-forget, skip if empty)
    if (scope.onResponse.length > 0) {
      runHooksFireAndForget(scope.onResponse, request, reply, this.log);
    }

    return response;
  }

  private async createMissContext(
    request: Request,
    effectiveUrl: string,
  ): Promise<{ request: CelsianRequest; reply: CelsianReply }> {
    const fullUrl = new URL(effectiveUrl, "http://localhost");
    const celsianRequest = buildRequest(request, fullUrl, {});
    const reply = createReply(fullUrl, request.headers);
    if (this.rootScope.replyDecorations.size > 0) {
      for (const [key, value] of this.rootScope.replyDecorations) {
        (reply as Record<string, unknown>)[key] = typeof value === "function" ? value() : value;
      }
    }
    return { request: celsianRequest, reply };
  }

  private mergeReplyHeaders(base: Record<string, string>, reply: CelsianReply): Headers {
    const headers = new Headers(base);
    for (const [key, value] of Object.entries(reply.headers)) {
      headers.set(key, value);
    }
    return headers;
  }

  /** Run an already-resolved onSend chain against a response built outside the normal lifecycle. */
  private async applyOnSend(
    response: Response,
    request: CelsianRequest,
    reply: CelsianReply,
    hooks: HookHandler[],
  ): Promise<Response> {
    if (hooks.length === 0) return response;
    try {
      await runOnSendHooks(hooks, request, reply);
    } catch (err) {
      this.log.error("onSend hook error", { error: err instanceof Error ? err.message : String(err) });
      return response;
    }
    const replyHeaders = reply.headers;
    if (Object.keys(replyHeaders).length === 0) return response;
    const merged = new Headers(response.headers);
    for (const [k, v] of Object.entries(replyHeaders)) {
      merged.set(k, v);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: merged,
    });
  }

  private validateRequest(request: CelsianRequest, schema: NonNullable<InternalRoute["schema"]>): void {
    if (schema.body) {
      const bodySchema: StandardSchema = fromSchema(schema.body);
      const result = bodySchema.validate(request.parsedBody);
      if (!result.success) {
        throw new ValidationError(result.issues ?? []);
      }
      request.parsedBody = result.data;
    }

    if (schema.querystring) {
      const querySchema: StandardSchema = fromSchema(schema.querystring);
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
      const paramsSchema: StandardSchema = fromSchema(schema.params);
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
  private async validateResponse(response: Response, handlerResult: unknown, route: InternalRoute): Promise<Response> {
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
      if (!(response.headers.get("content-type") ?? "").includes("json")) return response;

      // Only a body that was already serialized in memory may be read here.
      // `response.clone().json()` looks harmless but it TEES the body stream and
      // drains it to completion, so a live `reply.stream()` of NDJSON or
      // progressive JSON was fully buffered before the client saw its first
      // byte, and an endless stream hung until the request timeout fired a 504.
      // A response carrying a fast payload was built from a string or a byte
      // array, so parsing that payload reads no stream at all.
      const fast = getFastPayload(response);
      if (fast === undefined || fast.body === null) return response;
      try {
        payload = JSON.parse(typeof fast.body === "string" ? fast.body : RESPONSE_DECODER.decode(fast.body));
      } catch {
        // Body is not JSON after all, nothing to check.
        return response;
      }
    }

    const result = fromSchema(responseSchema).validate(payload);
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
    return fastResponse(CelsianApp.RESPONSE_VALIDATION_BODY, 500, CelsianApp.JSON_CONTENT_TYPE);
  }

  private parseBody(request: CelsianRequest): Promise<void> {
    return parseBody(request, this.cachedBodyLimit, this.contentTypeParsers);
  }

  private handleError(
    error: Error,
    request: CelsianRequest,
    reply: CelsianReply,
    scope: ResolvedScope,
  ): Promise<Response> {
    return handleErrorFn(error, request, reply, this.errorHandler, scope.onError, this.hasLogger ? this.log : null);
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
