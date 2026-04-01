// @celsian/core — Encapsulation context for plugin isolation

import { assertDecorationUnique } from "./errors.js";
import { cloneHookStore, createHookStore, type HookStore } from "./hooks.js";
import type { Router } from "./router.js";
import type {
  HookHandler,
  HookName,
  OnErrorHandler,
  PluginContext,
  PluginFunction,
  PluginOptions,
  RouteHandler,
  RouteMethod,
  RouteOptions,
} from "./types.js";

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

  /** Collect all decorations from this context and all descendants (depth-first). */
  collectAllDecorations(): Map<string, unknown> {
    const result = new Map(this.decorations);
    for (const child of this.children) {
      for (const [name, value] of child.collectAllDecorations()) {
        if (!result.has(name)) {
          result.set(name, value);
        }
      }
    }
    return result;
  }

  toPluginContext(): PluginContext {
    const ctx = this;

    const addRoute = (method: RouteMethod, url: string, handler: RouteHandler, opts?: Partial<RouteOptions>) => {
      const fullUrl = ctx.prefix + url;
      ctx.router.addRoute(method, fullUrl, handler, opts?.kind ?? "serverless", opts?.schema, {
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
          ...(opts?.preSerialization
            ? Array.isArray(opts.preSerialization)
              ? opts.preSerialization
              : [opts.preSerialization]
            : []),
        ],
        onSend: opts?.onSend ? (Array.isArray(opts.onSend) ? opts.onSend : [opts.onSend]) : [],
      });
    };

    // Cast to PluginContext: the generic route method signatures are type-level only.
    // At runtime, handlers always receive CelsianRequest<Record<string, string>>.
    return {
      async register(plugin: PluginFunction, options: PluginOptions = {}) {
        if (options.encapsulate === false) {
          // Non-encapsulated: plugin affects parent context directly
          await plugin(ctx.toPluginContext(), options as Record<string, unknown>);
        } else {
          const childCtx = ctx.createChild(options.prefix ?? "");
          await plugin(childCtx.toPluginContext(), options as Record<string, unknown>);
        }
      },

      route(options: RouteOptions) {
        const methods = Array.isArray(options.method) ? options.method : [options.method];
        for (const method of methods) {
          addRoute(method, options.url, options.handler, options);
        }
      },

      get(url: string, handlerOrOpts: RouteHandler | Record<string, unknown>, handler?: RouteHandler) {
        if (typeof handlerOrOpts === "function") {
          addRoute("GET", url, handlerOrOpts);
        } else {
          addRoute("GET", url, handler as RouteHandler, handlerOrOpts as Partial<RouteOptions>);
        }
      },
      post(url: string, handlerOrOpts: RouteHandler | Record<string, unknown>, handler?: RouteHandler) {
        if (typeof handlerOrOpts === "function") {
          addRoute("POST", url, handlerOrOpts);
        } else {
          addRoute("POST", url, handler as RouteHandler, handlerOrOpts as Partial<RouteOptions>);
        }
      },
      put(url: string, handlerOrOpts: RouteHandler | Record<string, unknown>, handler?: RouteHandler) {
        if (typeof handlerOrOpts === "function") {
          addRoute("PUT", url, handlerOrOpts);
        } else {
          addRoute("PUT", url, handler as RouteHandler, handlerOrOpts as Partial<RouteOptions>);
        }
      },
      patch(url: string, handlerOrOpts: RouteHandler | Record<string, unknown>, handler?: RouteHandler) {
        if (typeof handlerOrOpts === "function") {
          addRoute("PATCH", url, handlerOrOpts);
        } else {
          addRoute("PATCH", url, handler as RouteHandler, handlerOrOpts as Partial<RouteOptions>);
        }
      },
      delete(url: string, handlerOrOpts: RouteHandler | Record<string, unknown>, handler?: RouteHandler) {
        if (typeof handlerOrOpts === "function") {
          addRoute("DELETE", url, handlerOrOpts);
        } else {
          addRoute("DELETE", url, handler as RouteHandler, handlerOrOpts as Partial<RouteOptions>);
        }
      },

      addHook(name: HookName, handler: HookHandler | OnErrorHandler) {
        if (name === "onError") {
          ctx.hooks.onError.push(handler as OnErrorHandler);
        } else {
          (ctx.hooks[name] as HookHandler[]).push(handler as HookHandler);
        }
        // onSend and onResponse are cross-cutting — propagate to parent so they
        // apply to all routes, not just routes registered within this plugin context
        if ((name === "onSend" || name === "onResponse") && ctx.parent) {
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
    } as unknown as PluginContext;
  }
}
