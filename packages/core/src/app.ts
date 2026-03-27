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
  TypedRouteHandler,
} from "./types.js";
import { type WSHandler, WSRegistry } from "./websocket.js";

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

  async register(plugin: PluginFunction, options?: PluginOptions): Promise<void> {
    assertPlugin(plugin);
    const before = new Set(this.rootContext.decorations.keys());
    const p = this.pluginContext.register(plugin, options).then(() => {
      // Sync new decorations from plugin context to app instance (BUG-4 fix)
      for (const [name, value] of this.rootContext.decorations) {
        if (!before.has(name) && !(name in this)) {
          Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
        }
      }
    });
    this.pendingPlugins.push(p);
    return p;
  }

  route(options: RouteOptions): void {
    this.pluginContext.route(options);
  }

  get<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void {
    this.pluginContext.get(url, handler);
  }

  post<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void {
    this.pluginContext.post(url, handler);
  }

  put<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void {
    this.pluginContext.put(url, handler);
  }

  patch<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void {
    this.pluginContext.patch(url, handler);
  }

  delete<T extends string>(url: T, handler: TypedRouteHandler<ExtractRouteParams<T>>): void {
    this.pluginContext.delete(url, handler);
  }

  addHook(name: "onError", handler: OnErrorHandler): void;
  addHook(name: Exclude<HookName, "onError">, handler: HookHandler): void;
  addHook(name: HookName, handler: HookHandler | OnErrorHandler): void {
    this.pluginContext.addHook(name, handler as HookHandler);
  }

  decorate(name: string, value: unknown): void {
    this.pluginContext.decorate(name, value);
    Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
  }

  getDecoration(name: string): unknown {
    return this.rootContext.decorations.get(name);
  }

  decorateRequest(name: string, value: unknown): void {
    this.pluginContext.decorateRequest(name, value);
  }

  decorateReply(name: string, value: unknown): void {
    this.rootContext.replyDecorations.set(name, value);
  }

  setNotFoundHandler(handler: RouteHandler): void {
    this.notFoundHandler = handler;
  }

  setErrorHandler(
    handler: (error: Error, request: CelsianRequest, reply: CelsianReply) => Response | Promise<Response>,
  ): void {
    this.errorHandler = handler;
  }

  // ─── Content-Type Parsers ───

  addContentTypeParser(contentType: string, parser: (request: Request) => Promise<unknown>): void {
    this.contentTypeParsers.set(contentType, parser);
  }

  // ─── Task System ───

  task<TInput = unknown>(definition: TaskDefinition<TInput>): void {
    this.taskRegistry.register(definition);
  }

  async enqueue(taskName: string, input: unknown): Promise<string> {
    return createEnqueue(this._queue, this.taskRegistry)(taskName, input);
  }

  set queue(backend: QueueBackend) {
    this._queue = backend;
  }

  get queue(): QueueBackend {
    return this._queue;
  }

  setTaskWorkerOptions(options: TaskWorkerOptions): void {
    this.taskWorkerOptions = options;
  }

  startWorker(): void {
    if (this.taskWorker) return;
    this.taskWorker = new TaskWorker(this.taskRegistry, this._queue, this.log, this.taskWorkerOptions);
    this.taskWorker.start();
  }

  async stopWorker(): Promise<void> {
    if (this.taskWorker) {
      await this.taskWorker.stop();
      this.taskWorker = null;
    }
  }

  // ─── Cron ───

  cron(name: string, schedule: string, handler: () => Promise<void> | void): void {
    this.cronScheduler.add({ name, schedule, handler });
  }

  startCron(): void {
    this.cronScheduler.start();
  }

  stopCron(): void {
    this.cronScheduler.stop();
  }

  getCronJobs(): CronJob[] {
    return this.cronScheduler.getJobs();
  }

  // ─── WebSocket ───

  ws(path: string, handler: WSHandler): void {
    this.wsRegistry.register(path, handler);
  }

  wsBroadcast(path: string, data: string | ArrayBuffer, exclude?: string): void {
    this.wsRegistry.broadcast(path, data, exclude);
  }

  // ─── Health Check ───

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

  async inject(options: InjectOptions): Promise<Response> {
    return createInject(this)(options);
  }

  // ─── Request Handling ───

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
        } catch {
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

  get fetch(): (request: Request) => Promise<Response> {
    return this.handle.bind(this);
  }

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
      runHooksFireAndForget(this.rootContext.hooks.onResponse, request, reply);
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
    }

    if (schema.params) {
      const paramsSchema: StandardSchema = fromSchema(schema.params);
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
          const text = await request.text();
          if (bodyLimit > 0 && text.length > bodyLimit) {
            throw new HttpError(413, "Payload Too Large");
          }
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
        const text = await request.text();
        if (bodyLimit > 0 && text.length > bodyLimit) {
          throw new HttpError(413, "Payload Too Large");
        }
        request.parsedBody = text;
      } else if (!contentType) {
        // No content-type: try JSON, fall back to text
        const text = await request.text();
        if (bodyLimit > 0 && text.length > bodyLimit) {
          throw new HttpError(413, "Payload Too Large");
        }
        if (!text.trim()) return;
        try {
          request.parsedBody = JSON.parse(text);
        } catch {
          request.parsedBody = text;
        }
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // Body parsing failed for other reasons — leave as undefined
    }
  }

  private async handleError(error: Error, request: CelsianRequest, reply: CelsianReply): Promise<Response> {
    // Try custom error handler first
    if (this.errorHandler) {
      try {
        const result = await this.errorHandler(error, request, reply);
        if (result instanceof Response) return result;
      } catch {
        // Fall through to hooks / default
      }
    }

    for (const handler of this.rootContext.hooks.onError) {
      try {
        const result = await handler(error, request, reply);
        if (result instanceof Response) {
          return result;
        }
      } catch {
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

export function createApp(options?: CelsianAppOptions): CelsianApp {
  return new CelsianApp(options);
}
