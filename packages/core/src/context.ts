// @celsian/core — Encapsulation context for plugin isolation

import { Router } from './router.js';
import { createHookStore, cloneHookStore, type HookStore } from './hooks.js';
import { assertDecorationUnique } from './errors.js';
import type {
  HookHandler,
  OnErrorHandler,
  HookName,
  RouteMethod,
  RouteHandler,
  RouteOptions,
  PluginFunction,
  PluginOptions,
  PluginContext,
} from './types.js';

export class EncapsulationContext {
  readonly prefix: string;
  readonly hooks: HookStore;
  readonly decorations: Map<string, unknown>;
  readonly requestDecorations: Map<string, unknown>;
  readonly replyDecorations: Map<string, unknown>;
  readonly router: Router;
  private children: EncapsulationContext[] = [];

  constructor(
    readonly parent: EncapsulationContext | null,
    prefix: string,
    parentRouter: Router,
  ) {
    this.prefix = parent ? parent.prefix + prefix : prefix;

    if (parent) {
      this.hooks = cloneHookStore(parent.hooks);
      this.decorations = new Map(parent.decorations);
      this.requestDecorations = new Map(parent.requestDecorations);
      this.replyDecorations = new Map(parent.replyDecorations);
    } else {
      this.hooks = createHookStore();
      this.decorations = new Map();
      this.requestDecorations = new Map();
      this.replyDecorations = new Map();
    }

    this.router = parentRouter;
  }

  createChild(prefix: string): EncapsulationContext {
    const child = new EncapsulationContext(this, prefix, this.router);
    this.children.push(child);
    return child;
  }

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
          onSend: opts?.onSend ? (Array.isArray(opts.onSend) ? opts.onSend : [opts.onSend]) : [],
        },
      );
    };

    return {
      async register(plugin: PluginFunction, options: PluginOptions = {}) {
        if (options.encapsulate === false) {
          // Non-encapsulated: plugin affects parent context directly
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

      get(url: string, handler: RouteHandler) { addRoute('GET', url, handler); },
      post(url: string, handler: RouteHandler) { addRoute('POST', url, handler); },
      put(url: string, handler: RouteHandler) { addRoute('PUT', url, handler); },
      patch(url: string, handler: RouteHandler) { addRoute('PATCH', url, handler); },
      delete(url: string, handler: RouteHandler) { addRoute('DELETE', url, handler); },

      addHook(name: HookName, handler: HookHandler | OnErrorHandler) {
        if (name === 'onError') {
          ctx.hooks.onError.push(handler as OnErrorHandler);
        } else {
          (ctx.hooks[name] as HookHandler[]).push(handler as HookHandler);
        }
        // onSend and onResponse are cross-cutting — propagate to parent so they
        // apply to all routes, not just routes registered within this plugin context
        if ((name === 'onSend' || name === 'onResponse') && ctx.parent) {
          let ancestor: EncapsulationContext | null = ctx.parent;
          while (ancestor) {
            (ancestor.hooks[name] as HookHandler[]).push(handler as HookHandler);
            ancestor = ancestor.parent;
          }
        }
      },

      decorate(name: string, value: unknown) {
        if (ctx.decorations.has(name)) {
          assertDecorationUnique(name, ctx.decorations.get(name), value);
        }
        ctx.decorations.set(name, value);
      },
      decorateRequest(name: string, value: unknown) {
        ctx.requestDecorations.set(name, value);
      },
      decorateReply(name: string, value: unknown) {
        ctx.replyDecorations.set(name, value);
      },
      getRoutes() {
        return ctx.router.getAllRoutes();
      },
    };
  }
}
