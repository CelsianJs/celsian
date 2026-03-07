// @celsian/server — CelsianApp: hook-based server with plugin encapsulation

import { Router } from './router.js';
import { createReply } from './reply.js';
import type {
  CelsianAppOptions,
  CelsianRequest,
  CelsianReply,
  HookHandler,
  OnErrorHandler,
  HookName,
  RouteMethod,
  RouteHandler,
  RouteOptions,
  PluginFunction,
  PluginOptions,
  PluginContext,
  InternalRoute,
} from './types.js';
import { kSkipOverride } from './types.js';

// ─── Hook Store ───

interface HookStore {
  onRequest: HookHandler[];
  preParsing: HookHandler[];
  preValidation: HookHandler[];
  preHandler: HookHandler[];
  preSerialization: HookHandler[];
  onSend: HookHandler[];
  onResponse: HookHandler[];
  onError: OnErrorHandler[];
}

function createHookStore(): HookStore {
  return {
    onRequest: [],
    preParsing: [],
    preValidation: [],
    preHandler: [],
    preSerialization: [],
    onSend: [],
    onResponse: [],
    onError: [],
  };
}

// ─── Encapsulation Context ───

class EncapsulationContext {
  readonly prefix: string;
  readonly hooks: HookStore;
  readonly decorations: Map<string, unknown>;
  readonly requestDecorations: Map<string, unknown>;
  readonly router: Router;
  private children: EncapsulationContext[] = [];

  constructor(
    readonly parent: EncapsulationContext | null,
    prefix: string,
    parentRouter: Router,
  ) {
    this.prefix = parent ? parent.prefix + prefix : prefix;

    // Inherit parent hooks (shallow copy — child adds to its own copy)
    if (parent) {
      this.hooks = {
        onRequest: [...parent.hooks.onRequest],
        preParsing: [...parent.hooks.preParsing],
        preValidation: [...parent.hooks.preValidation],
        preHandler: [...parent.hooks.preHandler],
        preSerialization: [...parent.hooks.preSerialization],
        onSend: [...parent.hooks.onSend],
        onResponse: [...parent.hooks.onResponse],
        onError: [...parent.hooks.onError],
      };
      this.decorations = new Map(parent.decorations);
      this.requestDecorations = new Map(parent.requestDecorations);
    } else {
      this.hooks = createHookStore();
      this.decorations = new Map();
      this.requestDecorations = new Map();
    }

    // All contexts share the same router (routes stored with prefix)
    this.router = parentRouter;
  }

  createChild(prefix: string): EncapsulationContext {
    const child = new EncapsulationContext(this, prefix, this.router);
    this.children.push(child);
    return child;
  }

  /** Build a PluginContext interface for this encapsulation level */
  toPluginContext(): PluginContext {
    const ctx = this;

    const addRoute = (method: RouteMethod, url: string, handler: RouteHandler, opts?: Partial<RouteOptions>) => {
      const fullUrl = ctx.prefix + url;
      ctx.router.addRoute(
        method,
        fullUrl,
        handler,
        opts?.kind ?? 'serverless',
        opts?.schema,
        {
          onRequest: [
            ...ctx.hooks.onRequest,
            ...(opts?.onRequest ? (Array.isArray(opts.onRequest) ? opts.onRequest : [opts.onRequest]) : []),
          ],
          preHandler: [
            ...ctx.hooks.preHandler,
            ...(opts?.preHandler ? (Array.isArray(opts.preHandler) ? opts.preHandler : [opts.preHandler]) : []),
          ],
          preSerialization: [
            ...ctx.hooks.preSerialization,
            ...(opts?.preSerialization ? (Array.isArray(opts.preSerialization) ? opts.preSerialization : [opts.preSerialization]) : []),
          ],
        },
      );
    };

    return {
      async register(plugin: PluginFunction, options: PluginOptions = {}) {
        // If plugin has skip-override flag (wrapped with fp()), run on current context
        const skip = (plugin as PluginFunction & { [kSkipOverride]?: boolean })[kSkipOverride] === true;
        if (skip && !options.prefix) {
          await plugin(ctx.toPluginContext(), options as Record<string, unknown>);
        } else {
          const childCtx = ctx.createChild(options.prefix ?? '');
          await plugin(childCtx.toPluginContext(), options as Record<string, unknown>);
        }
      },

      route(options: RouteOptions) {
        const methods = Array.isArray(options.method) ? options.method : [options.method];
        for (const method of methods) {
          addRoute(method, options.url, options.handler, options);
        }
      },

      get(url: string, handler: RouteHandler) {
        addRoute('GET', url, handler);
      },
      post(url: string, handler: RouteHandler) {
        addRoute('POST', url, handler);
      },
      put(url: string, handler: RouteHandler) {
        addRoute('PUT', url, handler);
      },
      patch(url: string, handler: RouteHandler) {
        addRoute('PATCH', url, handler);
      },
      delete(url: string, handler: RouteHandler) {
        addRoute('DELETE', url, handler);
      },

      addHook(name: HookName, handler: HookHandler | OnErrorHandler) {
        if (name === 'onError') {
          ctx.hooks.onError.push(handler as OnErrorHandler);
        } else {
          (ctx.hooks[name] as HookHandler[]).push(handler as HookHandler);
        }
      },

      decorate(name: string, value: unknown) {
        ctx.decorations.set(name, value);
      },
      decorateRequest(name: string, value: unknown) {
        ctx.requestDecorations.set(name, value);
      },
    };
  }
}

// ─── CelsianApp ───

export class CelsianApp {
  private router = new Router();
  private rootContext: EncapsulationContext;
  private pluginContext: PluginContext;

  constructor(private options: CelsianAppOptions = {}) {
    this.rootContext = new EncapsulationContext(null, options.prefix ?? '', this.router);
    this.pluginContext = this.rootContext.toPluginContext();
  }

  // ─── Registration (delegate to plugin context) ───

  async register(plugin: PluginFunction, options?: PluginOptions): Promise<void> {
    return this.pluginContext.register(plugin, options);
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
  }

  decorateRequest(name: string, value: unknown): void {
    this.pluginContext.decorateRequest(name, value);
  }

  // ─── Request Handling ───

  /**
   * Handle a Web Standard Request → Response.
   * This is the core entry point used by all adapters.
   */
  async handle(request: Request): Promise<Response> {
    // Fast pathname extraction — avoid full URL parse when possible
    const rawUrl = request.url;
    const method = request.method as RouteMethod;
    let pathname: string;
    let _url: URL | null = null;

    // Extract pathname from raw URL string (skip protocol + host)
    const pathStart = rawUrl.indexOf('/', rawUrl.indexOf('//') + 2);
    const qIdx = rawUrl.indexOf('?', pathStart);
    pathname = qIdx === -1 ? rawUrl.substring(pathStart) : rawUrl.substring(pathStart, qIdx);

    // Match route
    const match = this.router.match(method, pathname);
    if (!match) {
      // For unmatched routes (e.g. OPTIONS preflight), still run root-level
      // onRequest hooks so middleware like CORS can handle them
      if (this.rootContext.hooks.onRequest.length > 0) {
        if (!_url) _url = new URL(rawUrl);
        const thenRequest = this.buildRequest(request, _url, rawUrl, {});
        const reply = createReply();
        const earlyResponse = await this.runHooks(this.rootContext.hooks.onRequest, thenRequest, reply);
        if (earlyResponse) return earlyResponse;
      }
      return new Response('Not Found', { status: 404 });
    }

    // Build CelsianRequest — URL only parsed lazily when query is accessed
    if (!_url) _url = new URL(rawUrl);
    const thenRequest = this.buildRequest(request, _url, rawUrl, match.params);

    // Apply request decorations from root context (skip when none registered)
    if (this.rootContext.requestDecorations.size > 0) {
      for (const [key, value] of this.rootContext.requestDecorations) {
        if (!(key in thenRequest)) {
          (thenRequest as Record<string, unknown>)[key] = typeof value === 'function' ? value() : value;
        }
      }
    }

    // Build CelsianReply
    const reply = createReply();

    try {
      // Run hook lifecycle
      return await this.runLifecycle(thenRequest, reply, match.route);
    } catch (error) {
      return this.handleError(error as Error, thenRequest, reply, match.route);
    }
  }

  /**
   * Returns a fetch-compatible handler function.
   * Useful for: Bun.serve({ fetch: app.fetch }), Deno.serve(app.fetch)
   */
  get fetch(): (request: Request) => Promise<Response> {
    return this.handle.bind(this);
  }

  /** Get all registered routes (for build manifest) */
  getRoutes(): InternalRoute[] {
    return this.router.getAllRoutes();
  }

  // ─── Internal ───

  private buildRequest(
    request: Request,
    url: URL,
    rawUrl: string,
    params: Record<string, string>,
  ): CelsianRequest {
    // Lazy query parsing — only allocate when accessed
    let _query: Record<string, string> | null = null;
    const hasQuery = rawUrl.indexOf('?') !== -1;

    // Create a CelsianRequest by extending the original request
    const thenRequest = Object.create(request, {
      params: { value: params, writable: true },
      query: {
        get() {
          if (!_query) {
            _query = {};
            if (hasQuery) {
              for (const [key, value] of url.searchParams) {
                _query[key] = value;
              }
            }
          }
          return _query;
        },
        set(v: Record<string, string>) { _query = v; },
        enumerable: true,
        configurable: true,
      },
      parsedBody: { value: undefined, writable: true },
    }) as CelsianRequest;

    return thenRequest;
  }

  private async runLifecycle(
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
  ): Promise<Response> {
    let earlyResponse: Response | null;

    // 1. onRequest hooks (route-specific inherit encapsulation hooks)
    if (route.hooks.onRequest.length > 0) {
      earlyResponse = await this.runHooks(route.hooks.onRequest, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 2. preParsing hooks
    if (this.rootContext.hooks.preParsing.length > 0) {
      earlyResponse = await this.runHooks(this.rootContext.hooks.preParsing, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 3. Body parsing (skip for GET/HEAD — most common path)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      await this.parseBody(request);
    }

    // 4. preValidation hooks
    if (this.rootContext.hooks.preValidation.length > 0) {
      earlyResponse = await this.runHooks(this.rootContext.hooks.preValidation, request, reply);
      if (earlyResponse) return earlyResponse;
    }

    // 5. Schema validation
    if (route.schema) {
      const validationError = this.validateRequest(request, route.schema);
      if (validationError) {
        return new Response(
          JSON.stringify({
            error: 'Validation Error',
            statusCode: 400,
            issues: validationError,
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }
    }

    // 6. preHandler hooks (route-specific inherit encapsulation hooks)
    if (route.hooks.preHandler.length > 0) {
      earlyResponse = await this.runHooks(route.hooks.preHandler, request, reply);
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

    // 8. preSerialization hooks
    if (route.hooks.preSerialization.length > 0) {
      await this.runHooks(route.hooks.preSerialization, request, reply);
    }

    // 9. onSend hooks
    if (this.rootContext.hooks.onSend.length > 0) {
      await this.runHooks(this.rootContext.hooks.onSend, request, reply);
    }

    // 10. onResponse hooks (fire-and-forget, after response)
    if (this.rootContext.hooks.onResponse.length > 0) {
      this.runHooksFireAndForget(this.rootContext.hooks.onResponse, request, reply);
    }

    // HEAD requests: return headers only, strip body (RFC 9110 §9.3.2)
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }

    return response;
  }

  private async runHooks(
    hooks: HookHandler[],
    request: CelsianRequest,
    reply: CelsianReply,
  ): Promise<Response | null> {
    for (const hook of hooks) {
      const result: unknown = await hook(request, reply);
      if (result instanceof Response) {
        return result; // Early response — short-circuit
      }
      if (reply.sent) {
        return reply.send(null); // Reply was marked as sent
      }
    }
    return null;
  }

  private runHooksFireAndForget(
    hooks: HookHandler[],
    request: CelsianRequest,
    reply: CelsianReply,
  ): void {
    for (const hook of hooks) {
      try {
        hook(request, reply);
      } catch {
        // Fire and forget — swallow errors
      }
    }
  }

  private async parseBody(request: CelsianRequest): Promise<void> {
    const contentType = request.headers.get('content-type') ?? '';

    // Note: GET/HEAD already skipped in runLifecycle() before calling this

    try {
      if (contentType.includes('application/json')) {
        request.parsedBody = await request.json();
      } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
        request.parsedBody = await request.formData();
      } else if (contentType.includes('text/')) {
        request.parsedBody = await request.text();
      }
    } catch {
      // Body parsing failed — leave as undefined
    }
  }

  private validateRequest(
    request: CelsianRequest,
    schema: NonNullable<RouteOptions['schema']>,
  ): Array<{ message: string; path?: string[] }> | null {
    const issues: Array<{ message: string; path?: string[] }> = [];

    // Validate body
    if (schema.body && request.parsedBody !== undefined) {
      const bodySchema = schema.body;
      if (typeof bodySchema === 'object' && bodySchema !== null && 'validate' in bodySchema) {
        const result = (bodySchema as { validate(input: unknown): { success: boolean; issues?: Array<{ message: string; path?: (string | number)[] }> } }).validate(request.parsedBody);
        if (!result.success && result.issues) {
          issues.push(...result.issues.map(i => ({
            message: i.message,
            path: ['body', ...(i.path?.map(String) ?? [])],
          })));
        }
      }
    }

    // Validate querystring
    if (schema.querystring) {
      const qsSchema = schema.querystring;
      if (typeof qsSchema === 'object' && qsSchema !== null && 'validate' in qsSchema) {
        const result = (qsSchema as { validate(input: unknown): { success: boolean; issues?: Array<{ message: string; path?: (string | number)[] }> } }).validate(request.query);
        if (!result.success && result.issues) {
          issues.push(...result.issues.map(i => ({
            message: i.message,
            path: ['querystring', ...(i.path?.map(String) ?? [])],
          })));
        }
      }
    }

    // Validate params
    if (schema.params) {
      const paramsSchema = schema.params;
      if (typeof paramsSchema === 'object' && paramsSchema !== null && 'validate' in paramsSchema) {
        const result = (paramsSchema as { validate(input: unknown): { success: boolean; issues?: Array<{ message: string; path?: (string | number)[] }> } }).validate(request.params);
        if (!result.success && result.issues) {
          issues.push(...result.issues.map(i => ({
            message: i.message,
            path: ['params', ...(i.path?.map(String) ?? [])],
          })));
        }
      }
    }

    return issues.length > 0 ? issues : null;
  }

  private async handleError(
    error: Error,
    request: CelsianRequest,
    reply: CelsianReply,
    route: InternalRoute,
  ): Promise<Response> {
    // Run onError hooks
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

    // Default error response
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return new Response(
      JSON.stringify({
        error: error.message || 'Internal Server Error',
        statusCode: status,
      }),
      {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }
}

// ─── Factory ───

export function createApp(options?: CelsianAppOptions): CelsianApp {
  return new CelsianApp(options);
}
