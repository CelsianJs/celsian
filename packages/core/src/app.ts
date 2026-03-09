// @celsian/core — CelsianApp: hook-based server with plugin encapsulation

import { Router } from './router.js';
import { createReply } from './reply.js';
import { buildRequest } from './request.js';
import { EncapsulationContext } from './context.js';
import { runHooks, runOnSendHooks, runHooksFireAndForget } from './hooks.js';
import { HttpError, ValidationError, assertPlugin, wrapNonError } from './errors.js';
import { fromSchema, type StandardSchema } from '@celsian/schema';
import { createInject, type InjectOptions } from './inject.js';
import { createLogger, generateRequestId, type Logger } from './logger.js';
import { parseCookies } from './cookie.js';
import { TaskRegistry, TaskWorker, createEnqueue, type TaskDefinition, type TaskWorkerOptions } from './task.js';
import { MemoryQueue, type QueueBackend } from './queue.js';
import { CronScheduler, type CronJob } from './cron.js';
import { WSRegistry, type WSHandler } from './websocket.js';
import type {
  CelsianAppOptions,
  CelsianRequest,
  CelsianReply,
  HookHandler,
  OnErrorHandler,
  HookName,
  RouteHandler,
  RouteOptions,
  PluginFunction,
  PluginOptions,
  PluginContext,
  InternalRoute,
  RouteManifestEntry,
} from './types.js';

export class CelsianApp {
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
  private errorHandler: ((error: Error, request: CelsianRequest, reply: CelsianReply) => Response | Promise<Response>) | null = null;

  // Custom content-type parsers
  private contentTypeParsers = new Map<string, (request: Request) => Promise<unknown>>();

  // Cron scheduling
  private cronScheduler = new CronScheduler();

  // WebSocket
  readonly wsRegistry = new WSRegistry();

  constructor(private options: CelsianAppOptions = {}) {
    this.rootContext = new EncapsulationContext(null, options.prefix ?? '', this.router);
    this.pluginContext = this.rootContext.toPluginContext();

    // Logger setup
    if (options.logger === true) {
      this.log = createLogger();
    } else if (options.logger && typeof options.logger === 'object') {
      this.log = options.logger;
    } else {
      // Silent no-op logger
      const noop = () => {};
      this.log = {
        level: 'info' as const,
        trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
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

  get(url: string, handler: RouteHandler): void {
    this.pluginContext.get(url, handler);
  }

  post(url: string, handler: RouteHandler): void {
    this.pluginContext.post(url, handler);
  }

  put(url: string, handler: RouteHandler): void {
    this.pluginContext.put(url, handler);
  }

  patch(url: string, handler: RouteHandler): void {
    this.pluginContext.patch(url, handler);
  }

  delete(url: string, handler: RouteHandler): void {
    this.pluginContext.delete(url, handler);
  }

  addHook(name: 'onError', handler: OnErrorHandler): void;
  addHook(name: Exclude<HookName, 'onError'>, handler: HookHandler): void;
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

  setErrorHandler(handler: (error: Error, request: CelsianRequest, reply: CelsianReply) => Response | Promise<Response>): void {
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

  health(options: {
    path?: string;
    readyPath?: string;
    check?: () => Promise<boolean> | boolean;
  } = {}): void {
    const healthPath = options.path ?? '/health';
    const readyPath = options.readyPath ?? '/ready';
    const check = options.check;

    this.get(healthPath, async (_req, reply) => {
      if (check) {
        const ok = await check();
        if (!ok) return reply.status(503).json({ status: 'unhealthy' });
      }
      return reply.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    this.get(readyPath, async (_req, reply) => {
      try {
        await this.ready();
        return reply.json({ status: 'ready' });
      } catch {
        return reply.status(503).json({ status: 'not ready' });
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
    await this.ready();

    const url = new URL(request.url);
    const method = request.method.toUpperCase() as import('./types.js').RouteMethod;
    const pathname = url.pathname;

    // Trust proxy: rewrite URL with forwarded headers
    if (this.options.trustProxy) {
      const proto = request.headers.get('x-forwarded-proto');
      const host = request.headers.get('x-forwarded-host');
      if (proto) url.protocol = proto + ':';
      if (host) url.host = host;
    }

    let match = this.router.match(method, pathname);

    // HEAD fallback: try GET handler if no explicit HEAD route
    if (!match && method === 'HEAD') {
      match = this.router.match('GET' as import('./types.js').RouteMethod, pathname);
    }

    if (!match) {
      // Distinguish 404 (path not found) from 405 (wrong method)
      if (this.router.hasPath(pathname)) {
        return new Response(JSON.stringify({ error: 'Method Not Allowed', statusCode: 405, code: 'METHOD_NOT_ALLOWED' }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      if (this.notFoundHandler) {
        const celsianRequest = buildRequest(request, url, {});
        const reply = createReply();
        // Apply reply decorations
        for (const [key, value] of this.rootContext.replyDecorations) {
          (reply as Record<string, unknown>)[key] = typeof value === 'function' ? value() : value;
        }
        try {
          const result = await this.notFoundHandler(celsianRequest, reply);
          if (result instanceof Response) return result;
          if (reply.sent) return new Response(null, { status: reply.statusCode });
          return new Response(null, { status: 404 });
        } catch {
          return new Response(JSON.stringify({ error: 'Not Found', statusCode: 404, code: 'NOT_FOUND' }), {
            status: 404,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
        }
      }
      return new Response(JSON.stringify({ error: 'Not Found', statusCode: 404, code: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const celsianRequest = buildRequest(request, url, match.params);

    // Apply request decorations
    for (const [key, value] of this.rootContext.requestDecorations) {
      if (!(key in celsianRequest)) {
        (celsianRequest as Record<string, unknown>)[key] = typeof value === 'function' ? value() : value;
      }
    }

    // Lazy cookie parsing
    let parsedCookies: Record<string, string> | null = null;
    Object.defineProperty(celsianRequest, 'cookies', {
      get: () => {
        if (!parsedCookies) {
          parsedCookies = parseCookies(request.headers.get('cookie') ?? '');
        }
        return parsedCookies;
      },
      configurable: true,
      enumerable: true,
    });

    // Attach child logger with requestId
    const requestId = generateRequestId();
    (celsianRequest as Record<string, unknown>).log = this.log.child({ requestId });
    (celsianRequest as Record<string, unknown>).requestId = requestId;

    const reply = createReply();

    // Apply reply decorations
    for (const [key, value] of this.rootContext.replyDecorations) {
      if (!(key in reply)) {
        (reply as Record<string, unknown>)[key] = typeof value === 'function' ? value() : value;
      }
    }

    // Wrap lifecycle with optional timeout (clear timer after completion to avoid leaks)
    const timeout = this.options.requestTimeout ?? 30_000;
    const runWithTimeout = async (): Promise<Response> => {
      const lifecycle = this.runLifecycle(celsianRequest, reply, match.route);
      if (timeout <= 0) return lifecycle;
      let timer: ReturnType<typeof setTimeout>;
      return Promise.race([
        lifecycle.finally(() => clearTimeout(timer)),
        new Promise<Response>((_, reject) => {
          timer = setTimeout(() => reject(new HttpError(504, 'Gateway Timeout')), timeout);
        }),
      ]);
    };

    // Auto request logging
    if (this.options.logger) {
      const start = performance.now();
      this.log.info('incoming request', { method, url: pathname, requestId });

      try {
        const response = await runWithTimeout();
        const duration = Math.round(performance.now() - start);
        this.log.info('request completed', { method, url: pathname, statusCode: response.status, duration, requestId });
        return response;
      } catch (thrown) {
        const error = wrapNonError(thrown);
        const response = await this.handleError(error, celsianRequest, reply);
        const duration = Math.round(performance.now() - start);
        this.log.error('request error', { method, url: pathname, statusCode: response.status, duration, requestId, error: error.message });
        return response;
      }
    }

    try {
      return await runWithTimeout();
    } catch (thrown) {
      return this.handleError(wrapNonError(thrown), celsianRequest, reply);
    }
  }

  get fetch(): (request: Request) => Promise<Response> {
    return this.handle.bind(this);
  }

  getRoutes(filter?: { kind?: 'serverless' | 'hot' | 'task' }): InternalRoute[] {
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
    const manifest = { serverless: [] as RouteManifestEntry[], hot: [] as RouteManifestEntry[], task: [] as RouteManifestEntry[] };
    for (const r of routes) {
      const bucket = manifest[r.kind as keyof typeof manifest];
      if (bucket) bucket.push({ method: r.method, url: r.url, kind: r.kind });
    }
    return manifest;
  }

  // ─── Internal ───

  private async runLifecycle(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
  ): Promise<Response> {
    // 1. onRequest hooks
    let earlyResponse = await runHooks(route.hooks.onRequest, request, reply);
    if (earlyResponse) return earlyResponse;

    // 2. preParsing hooks
    earlyResponse = await runHooks(this.rootContext.hooks.preParsing, request, reply);
    if (earlyResponse) return earlyResponse;

    // 3. Body parsing
    await this.parseBody(request);

    // 4. preValidation hooks
    earlyResponse = await runHooks(this.rootContext.hooks.preValidation, request, reply);
    if (earlyResponse) return earlyResponse;

    // 5. Schema validation
    if (route.schema) {
      this.validateRequest(request, route.schema);
    }

    // 6. preHandler hooks
    earlyResponse = await runHooks(route.hooks.preHandler, request, reply);
    if (earlyResponse) return earlyResponse;

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

    // 8. preSerialization hooks
    await runHooks(route.hooks.preSerialization, request, reply);

    // 9. onSend hooks — run route-level (from route options) then rootContext (includes plugin hooks)
    const hasOnSend = route.hooks.onSend.length > 0 || this.rootContext.hooks.onSend.length > 0;
    if (hasOnSend) {
      // Snapshot reply headers before onSend (handler/onRequest hooks already baked into response)
      const headersBefore = new Map<string, string>();
      for (const [k, v] of Object.entries(reply.headers)) {
        headersBefore.set(k, v);
      }

      // Route-level onSend (from route options only, not context-baked)
      await runOnSendHooks(route.hooks.onSend, request, reply);
      // Root-level onSend (includes hooks propagated up from encapsulated plugins)
      await runOnSendHooks(this.rootContext.hooks.onSend, request, reply);

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

    // 10. onResponse hooks (fire-and-forget)
    runHooksFireAndForget(this.rootContext.hooks.onResponse, request, reply);

    return response;
  }

  private validateRequest(
    request: CelsianRequest,
    schema: NonNullable<InternalRoute['schema']>,
  ): void {
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
    const contentType = request.headers.get('content-type') ?? '';

    if (request.method === 'GET' || request.method === 'HEAD') {
      return;
    }

    // Enforce body size limit
    const bodyLimit = this.options.bodyLimit ?? 1_048_576; // 1MB default
    if (bodyLimit > 0) {
      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > bodyLimit) {
        throw new HttpError(413, 'Payload Too Large');
      }
    }

    // Check custom content-type parsers (exact match then prefix match)
    for (const [registeredType, parser] of this.contentTypeParsers) {
      if (contentType === registeredType || contentType.startsWith(registeredType)) {
        request.parsedBody = await parser(request);
        return;
      }
    }

    try {
      if (contentType.includes('application/json')) {
        const text = await request.text();
        if (bodyLimit > 0 && text.length > bodyLimit) {
          throw new HttpError(413, 'Payload Too Large');
        }
        if (!text.trim()) return; // Empty body
        try {
          request.parsedBody = JSON.parse(text);
        } catch (parseErr) {
          throw new HttpError(400, `Invalid JSON (content-type: ${contentType}): ${(parseErr as Error).message}`, {
            code: 'INVALID_JSON',
            cause: parseErr as Error,
          });
        }
      } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
        request.parsedBody = await request.formData();
      } else if (contentType.includes('text/')) {
        const text = await request.text();
        if (bodyLimit > 0 && text.length > bodyLimit) {
          throw new HttpError(413, 'Payload Too Large');
        }
        request.parsedBody = text;
      } else if (!contentType) {
        // No content-type: try JSON, fall back to text
        const text = await request.text();
        if (bodyLimit > 0 && text.length > bodyLimit) {
          throw new HttpError(413, 'Payload Too Large');
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

  private async handleError(
    error: Error,
    request: CelsianRequest,
    reply: CelsianReply,
  ): Promise<Response> {
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
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    if (error instanceof HttpError) {
      return new Response(JSON.stringify(error.toJSON()), {
        status: error.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const isProduction = typeof process !== 'undefined'
      && (process.env.NODE_ENV === 'production' || process.env.CELSIAN_ENV === 'production');

    const body: Record<string, unknown> = {
      error: status >= 500 && isProduction ? 'Internal Server Error' : (error.message || 'Internal Server Error'),
      statusCode: status,
      code: (error as { code?: string }).code ?? 'INTERNAL_SERVER_ERROR',
    };

    if (!isProduction && error.stack) {
      body.stack = error.stack;
    }

    return new Response(
      JSON.stringify(body),
      {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }
}

export function createApp(options?: CelsianAppOptions): CelsianApp {
  return new CelsianApp(options);
}
