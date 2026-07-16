// @celsian/core — CelsianApp: hook-based server with plugin encapsulation

import { fromSchema, type StandardSchema } from "@celsian/schema";
import { parseBody } from "./body-parser.js";
import { EncapsulationContext } from "./context.js";
import { parseCookies } from "./cookie.js";
import { type CronJob, CronScheduler } from "./cron.js";
import { handleError as handleErrorFn } from "./error-handler.js";
import { assertPlugin, CelsianError, HttpError, ValidationError, wrapNonError } from "./errors.js";
import { fastResponse } from "./fast-response.js";
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

  // True when the user supplied no logger and we fell back to the silent no-op.
  // Safety warnings escalate to console.warn in that case so they stay visible.
  private readonly usingNoopLogger: boolean;

  constructor(private options: CelsianAppOptions = {}) {
    this.rootContext = new EncapsulationContext(null, options.prefix ?? "", this.router);
    this.pluginContext = this.rootContext.toPluginContext();

    // Cache hot-path options
    this.hasLogger = !!options.logger;
    this.cachedBodyLimit = options.bodyLimit ?? 1_048_576;
    this.cachedRequestTimeout = options.requestTimeout ?? 30_000;

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
  get<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery> & { handler: TypedSchemaHandler<ExtractRouteParams<T>> },
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
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>>,
  ): void;
  post<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery> & { handler: TypedSchemaHandler<ExtractRouteParams<T>> },
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
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>>,
  ): void;
  put<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery> & { handler: TypedSchemaHandler<ExtractRouteParams<T>> },
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
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>>,
  ): void;
  patch<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery> & { handler: TypedSchemaHandler<ExtractRouteParams<T>> },
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
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>>,
  ): void;
  delete<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery> & { handler: TypedSchemaHandler<ExtractRouteParams<T>> },
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
        `Route ${method} ${url} has no handler. Pass it as the last argument — app.${method.toLowerCase()}(url, opts, handler) — or as opts.handler.`,
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

  /** Add a named property to every incoming CelsianRequest. */
  decorateRequest(name: PropertyKey, value: unknown): void {
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
      // Host-header injection guard: only honor x-forwarded-host when the value
      // appears in the configured trustedHosts allowlist. Without an allowlist,
      // keep the real Host to prevent attacker-controlled host/fullUrl.
      if (host && this.options.trustedHosts && this.options.trustedHosts.includes(host)) {
        fullUrl.host = host;
      }
    }

    let match: import("./types.js").RouteMatch | null;
    try {
      match = this.router.match(method, pathname);

      // HEAD fallback: try GET handler if no explicit HEAD route
      if (!match && method === "HEAD") {
        match = this.router.match("GET" as import("./types.js").RouteMethod, pathname);
      }
    } catch (matchError) {
      // Malformed URI in a param/wildcard segment (HttpError 400) — return a
      // structured error response instead of crashing the request.
      const missContext = await this.createMissContext(request, rawUrl, fullUrl);
      const response = await this.handleError(wrapNonError(matchError), missContext.request, missContext.reply);
      return this.applyRootOnSend(response, missContext.request, missContext.reply);
    }

    if (!match) {
      const missContext = await this.createMissContext(request, rawUrl, fullUrl);
      const earlyResponse = await runHooks(this.rootContext.hooks.onRequest, missContext.request, missContext.reply);
      if (earlyResponse) return earlyResponse;
      const missHeaders = this.mergeReplyHeaders(CelsianApp.JSON_CONTENT_TYPE, missContext.reply);

      // Distinguish 404 (path not found) from 405 (wrong method)
      if (this.router.hasPath(pathname)) {
        const r405 = new Response(CelsianApp.METHOD_NOT_ALLOWED_BODY, {
          status: 405,
          headers: missHeaders,
        });
        return this.applyRootOnSend(r405, missContext.request, missContext.reply);
      }
      if (this.notFoundHandler) {
        try {
          const result = await this.notFoundHandler(missContext.request, missContext.reply);
          if (result instanceof Response) return this.applyRootOnSend(result, missContext.request, missContext.reply);
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
          return this.applyRootOnSend(r404, missContext.request, missContext.reply);
        }
      }
      const r404 = new Response(CelsianApp.NOT_FOUND_BODY, {
        status: 404,
        headers: missHeaders,
      });
      return this.applyRootOnSend(r404, missContext.request, missContext.reply);
    }

    // Build CelsianRequest with fast query parsing (skip URL object when possible)
    const celsianRequest = buildRequestFast(request, pathname, queryString, match.params, fullUrl);

    // Apply request decorations (skip loop if none registered)
    if (this.rootContext.requestDecorations.size > 0) {
      for (const [key, value] of this.rootContext.requestDecorations) {
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
    const isHead = method === "HEAD";

    // Auto request logging
    if (this.hasLogger) {
      const requestId = (celsianRequest as Record<string, unknown>).requestId as string;
      const start = performance.now();
      this.log.info("incoming request", { method, url: pathname, requestId });

      try {
        let response = await this.runWithTimeout(celsianRequest, reply, match.route, timeout);
        if (isHead) response = new Response(null, { status: response.status, headers: response.headers });
        const duration = Math.round(performance.now() - start);
        this.log.info("request completed", { method, url: pathname, statusCode: response.status, duration, requestId });
        return response;
      } catch (thrown) {
        const error = wrapNonError(thrown);
        let response = await this.handleError(error, celsianRequest, reply);
        response = await this.applyRootOnSend(response, celsianRequest, reply);
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
      let response = await this.runWithTimeout(celsianRequest, reply, match.route, timeout);
      if (isHead) response = new Response(null, { status: response.status, headers: response.headers });
      return response;
    } catch (thrown) {
      let response = await this.handleError(wrapNonError(thrown), celsianRequest, reply);
      response = await this.applyRootOnSend(response, celsianRequest, reply);
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
    timeout: number,
  ): Promise<Response> {
    if (timeout <= 0) {
      return this.runLifecycle(request, reply, route);
    }
    // Per-request AbortController: exposed as request.signal so handlers can
    // observe cancellation, and aborted when the timeout fires (in addition to
    // rejecting with 504) so in-flight work can stop promptly.
    const controller = new AbortController();
    (request as Record<string, unknown>).signal = controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      this.runLifecycle(request, reply, route).finally(() => clearTimeout(timer)),
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new HttpError(504, "Gateway Timeout"));
          reject(new HttpError(504, "Gateway Timeout"));
        }, timeout);
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

    // 8. preSerialization hooks (skip if empty)
    if (route.hooks.preSerialization.length > 0) {
      await runHooks(route.hooks.preSerialization, request, reply);
    }

    // 9. onSend hooks — run route-level then rootContext (skip entirely if both empty)
    const hasRouteOnSend = route.hooks.onSend.length > 0;
    const hasRootOnSend = this.rootContext.hooks.onSend.length > 0;
    if (hasRouteOnSend || hasRootOnSend) {
      const headersBefore = new Map<string, string>();
      for (const [k, v] of Object.entries(reply.headers)) {
        headersBefore.set(k, v);
      }

      try {
        if (hasRouteOnSend) await runOnSendHooks(route.hooks.onSend, request, reply);
        if (hasRootOnSend) await runOnSendHooks(this.rootContext.hooks.onSend, request, reply);
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

    // 10. onResponse hooks (fire-and-forget, skip if empty)
    if (this.rootContext.hooks.onResponse.length > 0) {
      runHooksFireAndForget(this.rootContext.hooks.onResponse, request, reply, this.log);
    }

    return response;
  }

  private async createMissContext(
    request: Request,
    rawUrl: string,
    fullUrl: URL | null,
  ): Promise<{ request: CelsianRequest; reply: CelsianReply }> {
    if (!fullUrl) fullUrl = new URL(rawUrl, "http://localhost");
    const celsianRequest = buildRequest(request, fullUrl, {});
    const reply = createReply();
    if (this.rootContext.replyDecorations.size > 0) {
      for (const [key, value] of this.rootContext.replyDecorations) {
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

  private async applyRootOnSend(response: Response, request: CelsianRequest, reply: CelsianReply): Promise<Response> {
    if (this.rootContext.hooks.onSend.length === 0) return response;
    try {
      await runOnSendHooks(this.rootContext.hooks.onSend, request, reply);
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

  private parseBody(request: CelsianRequest): Promise<void> {
    return parseBody(request, this.cachedBodyLimit, this.contentTypeParsers);
  }

  private handleError(error: Error, request: CelsianRequest, reply: CelsianReply): Promise<Response> {
    return handleErrorFn(
      error,
      request,
      reply,
      this.errorHandler,
      this.rootContext.hooks.onError,
      this.hasLogger ? this.log : null,
    );
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
