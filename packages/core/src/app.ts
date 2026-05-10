// @celsian/core — CelsianApp: hook-based server with plugin encapsulation

import { fromSchema, type StandardSchema } from "@celsian/schema";
import { EncapsulationContext } from "./context.js";
import { parseCookies } from "./cookie.js";
import { type CronJob, CronScheduler } from "./cron.js";
import { assertPlugin, HttpError, ValidationError, wrapNonError } from "./errors.js";
import { runHooks, runHooksFireAndForget, runOnSendHooks } from "./hooks.js";
import { createInject, type InjectOptions } from "./inject.js";
import { createLogger, generateRequestId, type Logger } from "./logger.js";
import { buildSecurityHeaders, security } from "./plugins/security.js";
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
  TypedSchemaHandler,
} from "./types.js";
import { type OnWsUpgradeHook, type WSHandler, WSRegistry } from "./websocket.js";

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
  private wsUpgradeHooks: OnWsUpgradeHook[] = [];

  // Cached options for hot path
  private readonly hasLogger: boolean;
  private readonly cachedBodyLimit: number;
  private readonly cachedRequestTimeout: number;

  // Pre-computed security headers for 404/405 responses (where onRequest hooks don't run)
  private readonly errorResponseHeaders: Record<string, string>;

  constructor(private options: CelsianAppOptions = {}) {
    this.rootContext = new EncapsulationContext(null, options.prefix ?? "", this.router);
    this.pluginContext = this.rootContext.toPluginContext();

    // Cache hot-path options
    this.hasLogger = !!options.logger;
    this.cachedBodyLimit = options.bodyLimit ?? 1_048_576;
    this.cachedRequestTimeout = options.requestTimeout ?? 30_000;

    // Pre-compute security headers for error responses (404/405)
    if (options.security !== false) {
      const securityOpts = typeof options.security === "object" ? options.security : {};
      this.errorResponseHeaders = {
        ...CelsianApp.JSON_CONTENT_TYPE,
        ...buildSecurityHeaders(securityOpts),
      };
    } else {
      this.errorResponseHeaders = { ...CelsianApp.JSON_CONTENT_TYPE };
    }

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

    // Auto-register security headers (enabled by default)
    if (options.security !== false) {
      const securityOpts = typeof options.security === "object" ? options.security : {};
      this.register(security(securityOpts), { encapsulate: false });
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
  route(options: RouteOptions): void {
    this.pluginContext.route(options);
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

  /** Register a handler for ALL HTTP methods on a path. */
  all<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void;
  all<T extends string, TBody, TQuery>(
    url: T,
    options: RouteSchemaOptions<TBody, TQuery>,
    handler: TypedSchemaHandler<ExtractRouteParams<T>>,
  ): void;
  all<T extends string>(
    url: T,
    handlerOrOpts: TypedRouteHandler<ExtractRouteParams<T>> | RouteSchemaOptions,
    handler?: TypedSchemaHandler,
  ): void {
    const methods: import("./types.js").RouteMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    if (typeof handlerOrOpts === "function") {
      for (const method of methods) {
        this.pluginContext.route({ method, url, handler: handlerOrOpts as RouteHandler });
      }
    } else {
      for (const method of methods) {
        this._routeWithSchema(method, url, handlerOrOpts, handler!);
      }
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

  /**
   * SPA fallback: serve an HTML file (or custom handler) for any unmatched route.
   * Useful for single-page applications where the client router handles paths.
   *
   * @param handlerOrPath - A file path to an HTML file, or a custom RouteHandler.
   *   When a string is given, the file is served with `text/html` content type.
   * @param options - Optional settings. `exclude` skips fallback for paths starting with given prefixes.
   *
   * @example
   * ```ts
   * // Serve index.html for all unmatched routes, except API paths
   * app.spaFallback('./dist/index.html', { exclude: ['/api'] });
   *
   * // Or with a custom handler
   * app.spaFallback((req, reply) => {
   *   return reply.html('<html><body>App</body></html>');
   * });
   * ```
   */
  spaFallback(handlerOrPath: string | RouteHandler, options?: { exclude?: string | string[] }): void {
    const excludePrefixes = options?.exclude
      ? Array.isArray(options.exclude)
        ? options.exclude
        : [options.exclude]
      : [];

    const makeHandler = (inner: RouteHandler): RouteHandler => {
      if (excludePrefixes.length === 0) return inner;
      return (req, reply) => {
        const pathname = new URL(req.url).pathname;
        for (const prefix of excludePrefixes) {
          if (pathname.startsWith(prefix)) {
            return reply.status(404).json({ error: "Not Found", statusCode: 404, code: "NOT_FOUND" });
          }
        }
        return inner(req, reply);
      };
    };

    if (typeof handlerOrPath === "string") {
      const filePath = handlerOrPath;
      this.notFoundHandler = makeHandler(async (_req, reply) => {
        return reply.sendFile(filePath);
      });
    } else {
      this.notFoundHandler = makeHandler(handlerOrPath);
    }
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
   * Custom parsers take priority over built-in parsers for JSON, form-data, and text.
   *
   * @param contentType - MIME type to match (e.g. 'application/xml', 'application/x-protobuf')
   * @param parser - Async function receiving the raw Request and returning parsed data
   *
   * @example
   * ```ts
   * // XML parser
   * app.addContentTypeParser('application/xml', async (request) => {
   *   const text = await request.text();
   *   return parseXML(text);
   * });
   *
   * // Protocol Buffers parser
   * app.addContentTypeParser('application/x-protobuf', async (request) => {
   *   const buffer = await request.arrayBuffer();
   *   return MyMessage.decode(new Uint8Array(buffer));
   * });
   *
   * // MessagePack parser
   * app.addContentTypeParser('application/msgpack', async (request) => {
   *   const buffer = await request.arrayBuffer();
   *   return decode(new Uint8Array(buffer));
   * });
   *
   * // Override built-in JSON parser
   * app.addContentTypeParser('application/json', async (request) => {
   *   const text = await request.text();
   *   return customJsonParse(text);
   * });
   * ```
   */
  addContentTypeParser(contentType: string, parser: (request: Request) => Promise<unknown>): void {
    this.contentTypeParsers.set(contentType, parser);
  }

  /**
   * Remove a previously registered custom content-type parser.
   *
   * @param contentType - The MIME type to remove the parser for
   * @returns true if the parser was found and removed, false otherwise
   */
  removeContentTypeParser(contentType: string): boolean {
    return this.contentTypeParsers.delete(contentType);
  }

  /**
   * Check if a custom parser is registered for a content-type.
   *
   * @param contentType - The MIME type to check
   */
  hasContentTypeParser(contentType: string): boolean {
    return this.contentTypeParsers.has(contentType);
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

  /**
   * Register a global WebSocket upgrade hook. Runs before every WS connection
   * is established, allowing auth checks. Return false or throw to reject.
   *
   * @example
   * ```ts
   * app.onWsUpgrade(async (req) => {
   *   const token = req.headers.get('authorization')?.replace('Bearer ', '');
   *   if (!token) return false;
   *   const user = await verifyToken(token);
   *   (req as any).user = user;
   * });
   * ```
   */
  onWsUpgrade(hook: OnWsUpgradeHook): void {
    this.wsUpgradeHooks.push(hook);
  }

  /** Run all WS upgrade hooks (global + per-handler). Returns false if rejected. */
  async runWsUpgradeHooks(request: CelsianRequest, handler: WSHandler): Promise<boolean> {
    // Run global hooks first
    for (const hook of this.wsUpgradeHooks) {
      try {
        const result = await hook(request);
        if (result === false) return false;
      } catch (err) {
        this.log.warn("WS upgrade hook error", { error: String(err) });
        return false;
      }
    }
    // Run per-handler hook
    if (handler.onUpgrade) {
      try {
        const result = await handler.onUpgrade(request);
        if (result === false) return false;
      } catch (err) {
        this.log.warn("WS upgrade hook error", { error: String(err) });
        return false;
      }
    }
    return true;
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

  // ─── Convenience: listen() ───

  /**
   * Start the server on the given port. Sugar for `serve(app, { port, ... })`.
   *
   * @param port - Port number to listen on (default: 3000)
   * @param callback - Optional callback called when the server is ready
   * @returns A handle with a `close()` method for graceful shutdown
   *
   * @example
   * ```ts
   * app.listen(3000, ({ port }) => console.log(`Running on ${port}`));
   *
   * // Or with await:
   * const { close } = await app.listen(3000);
   * ```
   */
  async listen(
    port?: number | import("./serve.js").ServeOptions,
    callback?: (info: { port: number; host: string }) => void,
  ): Promise<import("./serve.js").ServeResult> {
    const { serve } = await import("./serve.js");
    const options: import("./serve.js").ServeOptions = typeof port === "object" ? port : { port: port ?? 3000 };
    if (callback && !options.onReady) {
      options.onReady = callback;
    }
    return serve(this, options);
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
          headers: this.errorResponseHeaders,
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
            headers: this.errorResponseHeaders,
          });
        }
      }
      return new Response(CelsianApp.NOT_FOUND_BODY, {
        status: 404,
        headers: this.errorResponseHeaders,
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

    // Always generate requestId for tracing/correlation, even without logger
    const requestId = generateRequestId();
    (celsianRequest as Record<string, unknown>).requestId = requestId;

    // Only create child logger when logging is enabled
    if (this.hasLogger) {
      (celsianRequest as Record<string, unknown>).log = this.log.child({ requestId });
    }

    const reply = createReply(match.route.serializer);

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
      this.validateRequest(request, route);
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

    // Merge headers accumulated before finalization (for example security
    // headers from onRequest hooks) into raw Responses returned by handlers.
    // Explicit headers on the returned Response win; onSend changes below can
    // still intentionally override them.
    response = this.mergeReplyHeaders(response, reply.headers, false);

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
      runHooksFireAndForget(this.rootContext.hooks.onResponse, request, reply);
    }

    return response;
  }

  private validateRequest(request: CelsianRequest, route: InternalRoute): void {
    const schema = route.schema;
    if (!schema) return;

    if (schema.body) {
      const bodySchema: StandardSchema = route.validators?.body ?? fromSchema(schema.body);
      const result = bodySchema.validate(request.parsedBody);
      if (!result.success) {
        throw new ValidationError(result.issues ?? []);
      }
      request.parsedBody = result.data;
    }

    if (schema.querystring) {
      const querySchema: StandardSchema = route.validators?.querystring ?? fromSchema(schema.querystring);
      const result = querySchema.validate(request.query);
      if (!result.success) {
        throw new ValidationError(result.issues ?? []);
      }
      (request as Record<string, unknown>).parsedQuery = result.data;
    }

    if (schema.params) {
      const paramsSchema: StandardSchema = route.validators?.params ?? fromSchema(schema.params);
      const result = paramsSchema.validate(request.params);
      if (!result.success) {
        throw new ValidationError(result.issues ?? []);
      }
    }
  }

  private async parseBody(request: CelsianRequest): Promise<void> {
    const contentType = request.headers.get("content-type") ?? "";

    if (request.method === "GET" || request.method === "HEAD") {
      return;
    }

    // Enforce body size limit via Content-Length header (fast reject before reading)
    const bodyLimit = this.cachedBodyLimit;
    if (bodyLimit > 0) {
      const contentLength = request.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > bodyLimit) {
        throw new HttpError(413, "Payload Too Large");
      }
    }

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
        // Read body as text first to enforce body size limit on actual data
        // (Content-Length can be omitted in chunked transfer encoding)
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
        request.parsedBody = await this.readFormData(request, bodyLimit);
      } else if (contentType.includes("text/")) {
        const text = await this.readBodyText(request, bodyLimit);
        request.parsedBody = text;
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

  private mergeReplyHeaders(response: Response, replyHeaders: Record<string, string>, overwrite: boolean): Response {
    let needsMerge = false;
    for (const key of Object.keys(replyHeaders)) {
      if (overwrite || !response.headers.has(key)) {
        needsMerge = true;
        break;
      }
    }
    if (!needsMerge) return response;

    const mergedHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(replyHeaders)) {
      if (overwrite || !mergedHeaders.has(key)) {
        mergedHeaders.set(key, value);
      }
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: mergedHeaders,
    });
  }

  private async readBodyBytes(request: CelsianRequest, bodyLimit: number): Promise<ArrayBuffer> {
    const bytes = await request.arrayBuffer();
    if (bodyLimit > 0 && bytes.byteLength > bodyLimit) {
      throw new HttpError(413, "Payload Too Large");
    }
    return bytes;
  }

  private async readBodyText(request: CelsianRequest, bodyLimit: number): Promise<string> {
    return new TextDecoder().decode(await this.readBodyBytes(request, bodyLimit));
  }

  private async readFormData(request: CelsianRequest, bodyLimit: number): Promise<FormData> {
    const bytes = await this.readBodyBytes(request, bodyLimit);
    const replay = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bytes,
    });
    return replay.formData();
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
