// @celsian/core, Encapsulation context for plugin isolation

import { assertDecorationUnique, CelsianError } from "./errors.js";
import { createHookStore, type HookStore } from "./hooks.js";
import type { Router } from "./router.js";
import {
  type HookHandler,
  type HookName,
  type OnErrorHandler,
  type PluginContext,
  type PluginFunction,
  type PluginOptions,
  type ResolvedScope,
  ROUTE_SCOPE,
  type RouteHandler,
  type RouteHookChain,
  type RouteMethod,
  type RouteOptions,
} from "./types.js";

/** Hooks attached to a single route via its registration options. They always run last. */
type LocalHooks = Pick<ResolvedScope, "onRequest" | "preHandler" | "preSerialization" | "onSend">;

interface RouteBinding {
  /** The context the route was registered in, the leaf of its encapsulation chain. */
  ctx: EncapsulationContext;
  local: LocalHooks;
  scope: ResolvedScope;
}

/**
 * Tracks every registered route so its hook chain and decorations can be resolved
 * from its encapsulation-context chain rather than snapshotted at registration
 * time.
 *
 * Resolution is deferred and batched: `addHook`/`decorateRequest`/`decorateReply`
 * only flip a dirty flag, and `flush()` rebuilds every binding once, before the
 * next request. That keeps registration order irrelevant (hooks added after a
 * route, or by a plugin registered later, still apply) while leaving the request
 * hot path to a single boolean check.
 */
export class ScopeRegistry {
  /** True when at least one binding needs re-resolving. Checked once per request. */
  dirty = false;
  private bindings: RouteBinding[] = [];

  register(binding: RouteBinding): void {
    this.bindings.push(binding);
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const binding of this.bindings) {
      resolveBinding(binding);
    }
  }
}

function emptyLocalHooks(): LocalHooks {
  return { onRequest: [], preHandler: [], preSerialization: [], onSend: [] };
}

/**
 * Create a scope whose `onRequest` array carries a back-reference to the scope
 * itself, so the request path can recover it from `route.hooks.onRequest`.
 */
function createScope(): ResolvedScope {
  const onRequest: RouteHookChain = [];
  const scope: ResolvedScope = {
    onRequest,
    preParsing: [],
    preValidation: [],
    preHandler: [],
    preSerialization: [],
    onSend: [],
    onResponse: [],
    onError: [],
    requestDecorations: new Map(),
    replyDecorations: new Map(),
  };
  onRequest[ROUTE_SCOPE] = scope;
  return scope;
}

function appendHooks(target: HookHandler[], source: readonly HookHandler[]): void {
  for (const hook of source) target.push(hook);
}

/**
 * Every context whose hooks and decorations apply to a route registered in
 * `leaf`, in the order they should run.
 *
 * That is the route's own ancestor chain (root first), plus each ancestor's
 * *transparent* plugin subtrees. A plugin registered without a prefix is
 * transparent: it is app-wide middleware (cors, csrf, rate-limit, auth) and its
 * hooks apply to the scope it was registered into, including routes registered
 * on that scope later. A plugin registered *with* a prefix is not: its hooks
 * stay inside the prefix and never touch routes outside it.
 */
function collectScopeContexts(leaf: EncapsulationContext): EncapsulationContext[] {
  const chain: EncapsulationContext[] = [];
  for (let ctx: EncapsulationContext | null = leaf; ctx !== null; ctx = ctx.parent) {
    chain.push(ctx);
  }
  chain.reverse();

  const seen = new Set<EncapsulationContext>(chain);
  const ordered: EncapsulationContext[] = [];
  for (const ctx of chain) {
    ordered.push(ctx);
    collectTransparent(ctx, seen, ordered);
  }
  return ordered;
}

function collectTransparent(
  ctx: EncapsulationContext,
  seen: Set<EncapsulationContext>,
  out: EncapsulationContext[],
): void {
  for (const child of ctx.children) {
    // Prefixed children scope their hooks to that prefix; already-seen children
    // are part of the route's own chain and are visited in chain order.
    if (!child.transparent || seen.has(child)) continue;
    seen.add(child);
    out.push(child);
    collectTransparent(child, seen, out);
  }
}

/**
 * Rebuild a binding's scope from its context chain, then append the route's own
 * hooks. Arrays are cleared and refilled in place because the router holds
 * references to them.
 */
function resolveBinding(binding: RouteBinding): void {
  const chain = collectScopeContexts(binding.ctx);

  const scope = binding.scope;
  scope.onRequest.length = 0;
  scope.preParsing.length = 0;
  scope.preValidation.length = 0;
  scope.preHandler.length = 0;
  scope.preSerialization.length = 0;
  scope.onSend.length = 0;
  scope.onResponse.length = 0;
  scope.onError.length = 0;
  scope.requestDecorations.clear();
  scope.replyDecorations.clear();

  for (const ctx of chain) {
    appendHooks(scope.onRequest, ctx.hooks.onRequest);
    appendHooks(scope.preParsing, ctx.hooks.preParsing);
    appendHooks(scope.preValidation, ctx.hooks.preValidation);
    appendHooks(scope.preHandler, ctx.hooks.preHandler);
    appendHooks(scope.preSerialization, ctx.hooks.preSerialization);
    appendHooks(scope.onSend, ctx.hooks.onSend);
    appendHooks(scope.onResponse, ctx.hooks.onResponse);
    for (const handler of ctx.hooks.onError) scope.onError.push(handler);
    // Nearer scopes win: later contexts in the chain overwrite earlier ones.
    for (const [name, value] of ctx.requestDecorations) scope.requestDecorations.set(name, value);
    for (const [name, value] of ctx.replyDecorations) scope.replyDecorations.set(name, value);
  }

  appendHooks(scope.onRequest, binding.local.onRequest);
  appendHooks(scope.preHandler, binding.local.preHandler);
  appendHooks(scope.preSerialization, binding.local.preSerialization);
  appendHooks(scope.onSend, binding.local.onSend);
}

function toHookArray(value: HookHandler | HookHandler[] | undefined): HookHandler[] {
  if (!value) return [];
  return Array.isArray(value) ? [...value] : [value];
}

export class EncapsulationContext {
  readonly prefix: string;
  readonly hooks: HookStore;
  readonly decorations: Map<string, unknown>;
  readonly requestDecorations: Map<PropertyKey, unknown>;
  readonly replyDecorations: Map<string, unknown>;
  readonly router: Router;
  /** Shared with every context in this app so one flush resolves all routes. */
  readonly scopes: ScopeRegistry;
  /**
   * True when this context adds no prefix of its own, i.e. app-wide middleware.
   * Its hooks and decorations also apply to the scope it was registered into.
   * See {@link collectScopeContexts}.
   */
  readonly transparent: boolean;
  readonly children: EncapsulationContext[] = [];

  constructor(
    readonly parent: EncapsulationContext | null,
    prefix: string,
    parentRouter: Router,
  ) {
    this.prefix = parent ? parent.prefix + prefix : prefix;
    this.transparent = prefix === "";
    this.scopes = parent ? parent.scopes : new ScopeRegistry();

    // Hooks and request/reply decorations are NOT copied from the parent: they
    // are resolved by walking the context chain at flush time, so copying would
    // both duplicate them and freeze the parent's state at child-creation time.
    this.hooks = createHookStore();
    this.decorations = parent ? new Map(parent.decorations) : new Map();
    this.requestDecorations = new Map();
    this.replyDecorations = new Map();

    this.router = parentRouter;
  }

  createChild(prefix: string): EncapsulationContext {
    const child = new EncapsulationContext(this, prefix, this.router);
    this.children.push(child);
    // A transparent child widens the scope of routes already registered on the
    // parent, so previously-resolved chains have to be rebuilt.
    this.scopes.invalidate();
    return child;
  }

  /**
   * Create a resolved scope bound to this context with no route-level hooks.
   * Used for requests that never matched a route (404/405, malformed URI), which
   * only ever see the root context's hooks and decorations.
   */
  createContextScope(): ResolvedScope {
    const scope = createScope();
    this.scopes.register({ ctx: this, local: emptyLocalHooks(), scope });
    return scope;
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

      // The route's hook arrays are owned here and mutated in place by
      // resolveBinding; the router stores these exact references, so the route
      // always sees the current chain without any per-request resolution.
      const scope = createScope();
      ctx.scopes.register({
        ctx,
        local: {
          onRequest: toHookArray(opts?.onRequest),
          preHandler: toHookArray(opts?.preHandler),
          preSerialization: toHookArray(opts?.preSerialization),
          onSend: toHookArray(opts?.onSend),
        },
        scope,
      });

      ctx.router.addRoute(method, fullUrl, handler, opts?.kind ?? "serverless", opts?.schema, {
        onRequest: scope.onRequest,
        preHandler: scope.preHandler,
        preSerialization: scope.preSerialization,
        onSend: scope.onSend,
      });
    };

    // Options-object signature support: app.post(url, { schema, handler }).
    // A trailing handler argument takes precedence over opts.handler; registering
    // a route with no resolvable handler is a programming error, fail fast.
    const resolveHandler = (
      method: RouteMethod,
      url: string,
      opts: Record<string, unknown>,
      handler?: RouteHandler,
    ): RouteHandler => {
      const resolved = handler ?? opts.handler;
      if (typeof resolved !== "function") {
        throw new CelsianError(
          `Route ${method} ${url} has no handler. Pass it as the last argument, app.${method.toLowerCase()}(url, opts, handler), or as opts.handler.`,
        );
      }
      return resolved as RouteHandler;
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
          addRoute(
            "GET",
            url,
            resolveHandler("GET", url, handlerOrOpts, handler),
            handlerOrOpts as Partial<RouteOptions>,
          );
        }
      },
      post(url: string, handlerOrOpts: RouteHandler | Record<string, unknown>, handler?: RouteHandler) {
        if (typeof handlerOrOpts === "function") {
          addRoute("POST", url, handlerOrOpts);
        } else {
          addRoute(
            "POST",
            url,
            resolveHandler("POST", url, handlerOrOpts, handler),
            handlerOrOpts as Partial<RouteOptions>,
          );
        }
      },
      put(url: string, handlerOrOpts: RouteHandler | Record<string, unknown>, handler?: RouteHandler) {
        if (typeof handlerOrOpts === "function") {
          addRoute("PUT", url, handlerOrOpts);
        } else {
          addRoute(
            "PUT",
            url,
            resolveHandler("PUT", url, handlerOrOpts, handler),
            handlerOrOpts as Partial<RouteOptions>,
          );
        }
      },
      patch(url: string, handlerOrOpts: RouteHandler | Record<string, unknown>, handler?: RouteHandler) {
        if (typeof handlerOrOpts === "function") {
          addRoute("PATCH", url, handlerOrOpts);
        } else {
          addRoute(
            "PATCH",
            url,
            resolveHandler("PATCH", url, handlerOrOpts, handler),
            handlerOrOpts as Partial<RouteOptions>,
          );
        }
      },
      delete(url: string, handlerOrOpts: RouteHandler | Record<string, unknown>, handler?: RouteHandler) {
        if (typeof handlerOrOpts === "function") {
          addRoute("DELETE", url, handlerOrOpts);
        } else {
          addRoute(
            "DELETE",
            url,
            resolveHandler("DELETE", url, handlerOrOpts, handler),
            handlerOrOpts as Partial<RouteOptions>,
          );
        }
      },

      addHook(name: HookName, handler: HookHandler | OnErrorHandler) {
        if (name === "onError") {
          ctx.hooks.onError.push(handler as OnErrorHandler);
        } else {
          (ctx.hooks[name] as HookHandler[]).push(handler as HookHandler);
        }
        // Hooks are resolved per route from the context chain, so a hook added
        // after a route was registered still applies to it, and a hook added in
        // an encapsulated plugin applies only to that plugin's routes.
        ctx.scopes.invalidate();
      },

      decorate(name: string, value: unknown) {
        if (ctx.decorations.has(name)) {
          assertDecorationUnique(name, ctx.decorations.get(name), value);
        }
        ctx.decorations.set(name, value);
      },
      decorateRequest(name: PropertyKey, value: unknown, options?: { scope?: "plugin" | "app" }) {
        let target: EncapsulationContext = ctx;
        if (options?.scope === "app") {
          while (target.parent) target = target.parent;
        }
        target.requestDecorations.set(name, value);
        ctx.scopes.invalidate();
      },
      decorateReply(name: string, value: unknown) {
        ctx.replyDecorations.set(name, value);
        ctx.scopes.invalidate();
      },
      getRoutes() {
        return ctx.router.getAllRoutes();
      },
    } as unknown as PluginContext;
  }
}
