// @celsian/core — CelsianApp: hook-based server with plugin encapsulation

import { fromSchema, type StandardSchema } from "@celsian/schema";
import { EncapsulationContext } from "./context.js";
import { parseCookies } from "./cookie.js";
import { type CronJob, CronScheduler } from "./cron.js";
import { assertPlugin, HttpError, ValidationError, wrapNonError } from "./errors.js";
import { runHooks, runHooksFireAndForget, runOnSendHooks } from "./hooks.js";
import { createInject, type InjectOptions } from "./inject.js";
import { createLogger, generateRequestId, type Logger } from "./logger.js";
import { MemoryQueue, type QueueBackend } from "./queue.js";
import { createReply } from "./reply.js";
import { buildRequest, buildRequestFast } from "./request.js";
import { Router } from "./router.js";
import { createEnqueue, type TaskDefinition, TaskRegistry, TaskWorker, type TaskWorkerOptions } from "./task.js";
import type {
  CelsianAppOptions,
  CelsianReply,
  CelsianRequest,
  ExtractRouteParams,
  HookHandler,
  HookName,
  InternalRoute,
  OnErrorHandler,
  PluginContext,
  PluginFunction,
  PluginOptions,
  RouteHandler,
  RouteManifestEntry,
  RouteOptions,
  RouteSchemaOptions,
  TypedRouteHandler,
  TypedRouteOptions,
  TypedSchemaHandler,
} from "./types.js";
import { type WSHandler, WSRegistry } from "./websocket.js";

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
  private static readonly JSON_CONTENT_TYPE: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };

  private router = new Router();
  private rootContext: EncapsulationContext;
  private pluginContext: PluginContext;
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

  constructor(private options: CelsianAppOptions = {}) {
    this.rootContext = new EncapsulationContext(null, options.prefix ?? "", this.router);
    this.pluginContext = this.rootContext.toPluginContext();

    // Cache hot-path options
    this.hasLogger = !!options.logger;
    this.cachedBodyLimit = options.bodyLimit ?? 1_048_576;
    this.cachedRequestTimeout = options.requestTimeout ?? 30_000;

    // Logger setup
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

  /** Register a route with full options (method, url, schema, hooks, handler). */
  route(options: RouteOptions): void;
  route<TBody, TQuery>(options: TypedRouteOptions<TBody, TQuery>): void;
  route(options: RouteOptions | TypedRouteOptions): void {
    this.pluginContext.route(options as RouteOptions);
  }

  // Overloaded route methods: (path, handler) and (path, options, handler)
  get<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  get<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>>,
  ): void;
  get<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    if (typeof handlerOrOpts === "function") {
      this.pluginContext.get(url, handlerOrOpts);
    } else {
      this._routeWithSchema("GET", url, handlerOrOpts, handler!);
    }
  }

  post<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  post<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>>,
  ): void;
  post<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    if (typeof handlerOrOpts === "function") {
      this.pluginContext.post(url, handlerOrOpts);
    } else {
      this._routeWithSchema("POST", url, handlerOrOpts, handler!);
    }
  }

  put<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  put<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>>,
  ): void;
  put<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    if (typeof handlerOrOpts === "function") {
      this.pluginContext.put(url, handlerOrOpts);
    } else {
      this._routeWithSchema("PUT", url, handlerOrOpts, handler!);
    }
  }

  patch<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  patch<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>>,
  ): void;
  patch<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    if (typeof handlerOrOpts === "function") {
      this.pluginContext.patch(url, handlerOrOpts);
    } else {
      this._routeWithSchema("PATCH", url, handlerOrOpts, handler!);
    }
  }

  delete<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  delete<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>>,
  ): void;
  delete<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    if (typeof handlerOrOpts === "function") {
      this.pluginContext.delete(url, handlerOrOpts);
    } else {
      this._routeWithSchema("DELETE", url, handlerOrOpts, handler!);
    }
  }

  /** Internal: register a route with schema options from the typed overload */
  private _routeWithSchema(
    method: import("./types.js").RouteMethod,
    url: string,
    opts: RouteSchemaOptions,
    handler: TypedSchemaHandler,
  ): void {
    this.pluginContext.route({
      method,
      url,
      // Safe cast: at runtime, the request object will have parsedBody/parsedQuery
      // populated by validateRequest before the handler is called
      handler: handler as unknown as RouteHandler,
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

  /** Add a named property to every incoming CelsianRequest. */
  decorateRequest(name: string, value: unknown): void {
    this.pluginContext.decorateRequest(name, value);
  }

  /** Add a named property to every CelsianReply. */
  decorateReply(name: string, value: unknown): void {
    this.rootContext.replyDecorations.set(name, value);
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

  /** Register a custom body parser for a content-type (exact or prefix match). */
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

  /** Enqueue a background task by name. Returns the task ID. */
  async enqueue(taskName: string, input: unknown): Promise<string> {
    if (!this.taskWorker && !this._enqueuedWithoutWorkerWarned) {
      this.log.warn(
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

    // Serverless safety: warn once if cron jobs registered but scheduler not started
    if (!this._cronNotStartedWarned && this.cronScheduler.getJobs().length > 0 && !this.cronScheduler.isRunning) {
      const count = this.cronScheduler.getJobs().length;
      this.log.warn(
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
    let fullUrl: URL | null = null; // Lazy — only created if needed

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
          if (slashCount === 3) {
            pathStart = i;
            break;
          }
        }
      }
      if (pathStart === -1) {
        // No path component (e.g., "http://host") — default to "/"
        pathname = "/";
        queryString = "";
      } else {
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

    // Trust proxy: needs full URL object
    if (this.options.trustProxy) {
      if (!fullUrl) fullUrl = new URL(rawUrl, "http://localhost");
      const proto = request.headers.get("x-forwarded-proto");
      const host = request.headers.get("x-forwarded-host");
      if (proto) fullUrl.protocol = `${proto}:`;
      if (host) fullUrl.host = host;
    }

    let match = this.router.match(method, pathname);

    // HEAD fallback: try GET handler if no explicit HEAD route
    if (!match && method === "HEAD") {
      match = this.router.match("GET" as import("./types.js").RouteMethod, pathname);
    }

    if (!match) {
      // Distinguish 404 (path not found) from 405 (wrong method)
      if (this.router.hasPath(pathname)) {
        return new Response(CelsianApp.METHOD_NOT_ALLOWED_BODY, {
          status: 405,
          headers: CelsianApp.JSON_CONTENT_TYPE,
        });
      }
      if (this.notFoundHandler) {
        if (!fullUrl) fullUrl = new URL(rawUrl, "http://localhost");
        const celsianRequest = buildRequest(request, fullUrl, {});
        const reply = createReply();
        // Apply reply decorations
        if (this.rootContext.replyDecorations.size > 0) {
          for (const [key, value] of this.rootContext.replyDecorations) {
            (reply as Record<string, unknown>)[key] = typeof value === "function" ? value() : value;
          }
        }
        try {
          const result = await this.notFoundHandler(celsianRequest, reply);
          if (result instanceof Response) return result;
          if (reply.sent) return new Response(null, { status: reply.statusCode });
          return new Response(null, { status: 404 });
        } catch (error) {
          console.error("[celsian]", error);
          return new Response(CelsianApp.NOT_FOUND_BODY, {
            status: 404,
            headers: CelsianApp.JSON_CONTENT_TYPE,
          });
        }
      }
      return new Response(CelsianApp.NOT_FOUND_BODY, {
        status: 404,
        headers: CelsianApp.JSON_CONTENT_TYPE,
      });
    }

    // Build CelsianRequest with fast query parsing (skip URL object when possible)
    const celsianRequest = buildRequestFast(request, pathname, queryString, match.params, fullUrl);

    // Apply request decorations (skip loop if none registered)
    if (this.rootContext.requestDecorations.size > 0) {
      for (const [key, value] of this.rootContext.requestDecorations) {
        if (!(key in celsianRequest)) {
          (celsianRequest as Record<string, unknown>)[key] = typeof value === "function" ? value() : value;
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

    const reply = createReply();

    // Apply reply decorations (skip loop if none registered)
    if (this.rootContext.replyDecorations.size > 0) {
      for (const [key, value] of this.rootContext.replyDecorations) {
        if (!(key in reply)) {
          (reply as Record<string, unknown>)[key] = typeof value === "function" ? value() : value;
        }
      }
    }

    // Run lifecycle — inline timeout logic to avoid closure allocation
    const timeout = this.cachedRequestTimeout;

    // Auto request logging
    if (this.hasLogger) {
      const requestId = (celsianRequest as Record<string, unknown>).requestId as string;
      const start = performance.now();
      this.log.info("incoming request", { method, url: pathname, requestId });

      try {
        const response = await this.runWithTimeout(celsianRequest, reply, match.route, timeout);
        const duration = Math.round(performance.now() - start);
        this.log.info("request completed", { method, url: pathname, statusCode: response.status, duration, requestId });
        return response;
      } catch (thrown) {
        const error = wrapNonError(thrown);
        const response = await this.handleError(error, celsianRequest, reply);
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
      return await this.runWithTimeout(celsianRequest, reply, match.route, timeout);
    } catch (thrown) {
      return this.handleError(wrapNonError(thrown), celsianRequest, reply);
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
    timeout: number,
  ): Promise<Response> {
    if (timeout <= 0) {
      return this.runLifecycle(request, reply, route);
    }
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      this.runLifecycle(request, reply, route).finally(() => clearTimeout(timer)),
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new HttpError(504, "Gateway Timeout")), timeout);
      }),
    ]);
  }

  private async runLifecycle(request: CelsianRequest, reply: CelsianReply, route: InternalRoute): Promise<Response> {
    let earlyResponse: Response | null;

    // 1. onRequest hooks (skip if empty)
    if (route.hooks.onRequest.length > 0) {
      earlyResponse = await runHooks(route.hooks.onRequest, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 2. preParsing hooks (skip if empty)
    if (this.rootContext.hooks.preParsing.length > 0) {
      earlyResponse = await runHooks(this.rootContext.hooks.preParsing, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 3. Body parsing
    await this.parseBody(request);

    // 4. preValidation hooks (skip if empty)
    if (this.rootContext.hooks.preValidation.length > 0) {
      earlyResponse = await runHooks(this.rootContext.hooks.preValidation, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 5. Schema validation
    if (route.schema) {
      this.validateRequest(request, route.schema);
    }

    // 6. preHandler hooks (skip if empty)
    if (route.hooks.preHandler.length > 0) {
      earlyResponse = await runHooks(route.hooks.preHandler, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 7. Handler
    const handlerResult = await route.handler(request, reply);
    let response: Response;

    if (handlerResult instanceof Response) {
      response = handlerResult;
    } else if (reply.sent) {
      response = new Response(null, { status: reply.statusCode });
    } else {
      response = new Response(null, { status: 204 });
    }

    // 8. preSerialization hooks (skip if empty)
    if (route.hooks.preSerialization.length > 0) {
      await runHooks(route.hooks.preSerialization, request, reply);
    }

    // 9. onSend hooks — run route-level then rootContext (skip entirely if both empty)
    const hasRouteOnSend = route.hooks.onSend.length > 0;
    const hasRootOnSend = this.rootContext.hooks.onSend.length > 0;
    if (hasRouteOnSend || hasRootOnSend) {
      // Snapshot reply headers before onSend (handler/onRequest hooks already baked into response)
      const headersBefore = new Map<string, string>();
      for (const [k, v] of Object.entries(reply.headers)) {
        headersBefore.set(k, v);
      }

      // Route-level onSend (from route options only, not context-baked)
      if (hasRouteOnSend) await runOnSendHooks(route.hooks.onSend, request, reply);
      // Root-level onSend (includes hooks propagated up from encapsulated plugins)
      if (hasRootOnSend) await runOnSendHooks(this.rootContext.hooks.onSend, request, reply);

      // Merge headers that were added or changed during onSend
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

    // 10. onResponse hooks (fire-and-forget, skip if empty)
    if (this.rootContext.hooks.onResponse.length > 0) {
      runHooksFireAndForget(this.rootContext.hooks.onResponse, request, reply, this.log);
    }

    return response;
  }

  private validateRequest(request: CelsianRequest, schema: NonNullable<InternalRoute["schema"]>): void {
    if (schema.body && request.parsedBody !== undefined) {
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
      (request as Record<string, unknown>).parsedQuery = result.data;
    }

    if (schema.params) {
      const paramsSchema: StandardSchema = fromSchema(schema.params);
      const result = paramsSchema.validate(request.params);
      if (!result.success) {
        throw new ValidationError(result.issues ?? []);
      }
    }
  }

  /**
   * Read the request body as text, enforcing a byte limit during streaming.
   * Rejects with 413 if the body exceeds the limit before reading completes,
   * preventing memory exhaustion from chunked transfer encoding attacks.
   */
  private async readBodyText(request: Request, limit: number): Promise<string> {
    // Fast path: Content-Length is known — pre-check without reading
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > limit) {
      throw new HttpError(413, "Payload Too Large");
    }

    // If no body or limit disabled, read directly
    if (!request.body || limit <= 0) {
      return request.text();
    }

    // Stream the body with a byte counter — abort early if limit exceeded
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let result = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > limit) {
          throw new HttpError(413, "Payload Too Large");
        }
        result += decoder.decode(value, { stream: true });
      }
      // Flush the decoder
      result += decoder.decode();
    } finally {
      reader.releaseLock();
    }

    return result;
  }

  private async parseBody(request: CelsianRequest): Promise<void> {
    const contentType = request.headers.get("content-type") ?? "";

    if (request.method === "GET" || request.method === "HEAD") {
      return;
    }

    const bodyLimit = this.cachedBodyLimit;

    // Check custom content-type parsers (exact match then prefix match)
    if (this.contentTypeParsers.size > 0) {
      for (const [registeredType, parser] of this.contentTypeParsers) {
        if (contentType === registeredType || contentType.startsWith(registeredType)) {
          request.parsedBody = await parser(request);
          return;
        }
      }
    }

    try {
      if (contentType.includes("application/json")) {
        try {
          const text = await this.readBodyText(request, bodyLimit);
          if (!text.trim()) {
            // Empty body — leave as undefined
            return;
          }
          request.parsedBody = JSON.parse(text);
        } catch (parseErr) {
          if (parseErr instanceof HttpError) throw parseErr;
          throw new HttpError(400, `Invalid JSON (content-type: ${contentType}): ${(parseErr as Error).message}`, {
            code: "INVALID_JSON",
            cause: parseErr as Error,
          });
        }
      } else if (
        contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("multipart/form-data")
      ) {
        request.parsedBody = await request.formData();
      } else if (contentType.includes("text/")) {
        request.parsedBody = await this.readBodyText(request, bodyLimit);
      } else if (!contentType) {
        // No content-type: try JSON, fall back to text
        const text = await this.readBodyText(request, bodyLimit);
        if (!text.trim()) return;
        try {
          request.parsedBody = JSON.parse(text);
        } catch {
          request.parsedBody = text;
        }
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // Body parsing failed for other reasons — log and leave as undefined
      console.error("[celsian]", e);
    }
  }

  private async handleError(error: Error, request: CelsianRequest, reply: CelsianReply): Promise<Response> {
    // Try custom error handler first
    if (this.errorHandler) {
      try {
        const result = await this.errorHandler(error, request, reply);
        if (result instanceof Response) return result;
      } catch (handlerError) {
        console.error("[celsian]", handlerError);
        // Fall through to hooks / default
      }
    }

    for (const handler of this.rootContext.hooks.onError) {
      try {
        const result = await handler(error, request, reply);
        if (result instanceof Response) {
          return result;
        }
      } catch (hookError) {
        console.error("[celsian]", hookError);
        // Error in error handler — continue to default
      }
    }

    if (error instanceof ValidationError) {
      return new Response(JSON.stringify(error.toJSON()), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (error instanceof HttpError) {
      return new Response(JSON.stringify(error.toJSON()), {
        status: error.statusCode,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const isProduction =
      typeof process !== "undefined" &&
      (process.env.NODE_ENV === "production" || process.env.CELSIAN_ENV === "production");

    const body: Record<string, unknown> = {
      error: status >= 500 && isProduction ? "Internal Server Error" : error.message || "Internal Server Error",
      statusCode: status,
      code: (error as { code?: string }).code ?? "INTERNAL_SERVER_ERROR",
    };

    if (!isProduction && error.stack) {
      body.stack = error.stack;
    }

    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
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
