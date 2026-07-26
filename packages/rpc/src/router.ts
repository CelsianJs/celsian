// @celsian/rpc, Router + handler execution

import { generateOpenAPI } from "./openapi.js";
import type {
  ContextFactory,
  MiddlewareFunction,
  ProcedureDefinition,
  RouterDefinition,
  RPCContext,
  RPCManifest,
  RPCResponse,
} from "./types.js";
import { decode, encode } from "./wire.js";

/** Define an RPC router from a nested object of procedures. Identity function for type inference. */
export function router<T extends RouterDefinition>(routes: T): T {
  return routes;
}

/**
 * Minimal structural interface for {@link RPCHandler.mount} targets. Satisfied
 * by `CelsianApp` (and any router exposing `get`/`post` registration) without
 * requiring a dependency on `@celsian/core`.
 */
export interface RPCMountTarget {
  get(url: string, handler: (request: Request) => Response | Promise<Response>): void;
  post(url: string, handler: (request: Request) => Response | Promise<Response>): void;
}

/**
 * Minimal logger shape accepted by {@link RPCHandler}. Structurally compatible
 * with `@celsian/core`'s `Logger`, so `new RPCHandler(routes, { logger: app.log })`
 * type-checks without `@celsian/rpc` depending on core.
 */
export interface RPCLogger {
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * When to serve `/_rpc/openapi.json` and `/_rpc/manifest.json`.
 *
 * - `"development"` (default), served unless `NODE_ENV`/`CELSIAN_ENV` is `production`
 * - `true`, always served (pair with `introspectionMiddlewares`)
 * - `false`, never served
 */
export type IntrospectionMode = boolean | "development";

/** Options for {@link RPCHandler}. */
export interface RPCHandlerOptions {
  contextFactory?: ContextFactory;
  basePath?: string;
  /**
   * Gate the introspection endpoints. Defaults to `"development"`.
   *
   * These endpoints list every procedure path (including `admin.*` and
   * `internal.*`) plus full input/output JSON Schemas, and they are served
   * before procedure lookup, so per-procedure `middlewares` never ran for them.
   * Obscurity is not security, but handing an unauthenticated caller a complete
   * map of the API is a needless gift.
   */
  introspection?: IntrospectionMode;
  /**
   * Middleware run before the introspection endpoints are served. The
   * per-procedure chains cannot apply here, because these endpoints belong to
   * no procedure, use this to require auth for the schema dump.
   *
   * A middleware guards the endpoint by throwing (e.g. an `HttpError`) instead
   * of calling `next()`.
   */
  introspectionMiddlewares?: MiddlewareFunction[];
  /**
   * Reject cross-origin state-changing requests. Defaults to `true`.
   *
   * Requests carrying neither `Origin` nor `Sec-Fetch-Site` (curl,
   * server-to-server, native clients) are always allowed: the check exists to
   * constrain browsers, the only clients that attach ambient cookies.
   */
  originCheck?: boolean;
  /**
   * Extra origins allowed to make state-changing requests, e.g. a separate SPA
   * host. Needed whenever `request.url`'s origin is not the public origin
   * (reverse proxies) or the frontend lives on another domain.
   */
  allowedOrigins?: string[];
  /**
   * Logger for unexpected (5xx) procedure errors. Defaults to `console.error`.
   *
   * Pass `app.log` so 5xx detail flows through the app logger (redaction,
   * levels, sinks) instead of raw `console.error`, which any client can amplify
   * into log flooding.
   */
  logger?: RPCLogger;
}

/** Content types that are CORS-"simple" and therefore reachable by a cross-origin `<form>`. */
const FORM_CONTENT_TYPES = ["multipart/form-data", "application/x-www-form-urlencoded"];

/**
 * The MIME "essence": type/subtype, lowercased, with parameters and whitespace
 * stripped.
 *
 * A substring test is not a media-type test. `Content-Type: text/plain;
 * charset=application/json` contains the string "application/json" but is a
 * CORS-simple type a cross-origin form can send without a preflight, which is
 * the exact property the JSON requirement exists to guarantee.
 */
function mimeEssence(contentType: string): string {
  return (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

/** True for `application/json` and any structured-suffix `+json` type. */
function isJsonEssence(essence: string): boolean {
  return essence === "application/json" || essence.endsWith("+json");
}

function isProductionEnv(): boolean {
  return (
    typeof process !== "undefined" &&
    (process.env.NODE_ENV === "production" || process.env.CELSIAN_ENV === "production")
  );
}

/**
 * Server-side RPC handler. Flattens a router definition, validates input/output,
 * runs middleware, and serves OpenAPI and manifest endpoints.
 *
 * @example
 * ```ts
 * const rpc = new RPCHandler(appRouter);
 * rpc.mount(app); // registers GET + POST routes at /_rpc/*
 * ```
 */
export class RPCHandler {
  private flatRoutes = new Map<string, ProcedureDefinition>();
  private contextFactory: ContextFactory;
  private basePath: string;
  private introspection: IntrospectionMode;
  private introspectionMiddlewares: MiddlewareFunction[];
  private originCheck: boolean;
  private allowedOrigins: Set<string>;
  private logger: RPCLogger;

  constructor(routes: RouterDefinition, options?: RPCHandlerOptions) {
    this.contextFactory = options?.contextFactory ?? ((request) => ({ request }));
    this.basePath = options?.basePath ?? "/_rpc";
    this.introspection = options?.introspection ?? "development";
    this.introspectionMiddlewares = options?.introspectionMiddlewares ?? [];
    this.originCheck = options?.originCheck ?? true;
    this.allowedOrigins = new Set(options?.allowedOrigins ?? []);
    this.logger = options?.logger ?? {
      error(msg, data) {
        console.error(msg, data);
      },
    };
    this.flattenRoutes(routes, "");
  }

  /**
   * Mount this handler on a Celsian app (or any compatible router). Registers
   * BOTH `GET` and `POST` wildcard routes, the RPC client uses GET for
   * queries and POST for mutations, and `CelsianApp` has no `.all()` method.
   * This is the recommended way to wire up the handler.
   *
   * @param app - App exposing `get`/`post` route registration (e.g. `CelsianApp`).
   * @param prefix - Mount prefix. Defaults to the handler's `basePath`
   *   (`"/_rpc"`). When provided, it replaces the handler's base path so URL
   *   stripping in `handle()` matches the mounted location.
   *
   * @example
   * ```ts
   * const rpc = new RPCHandler(appRouter);
   * rpc.mount(app);              // serves /_rpc/*
   * rpc.mount(app, '/api/rpc');  // serves /api/rpc/*
   * ```
   */
  mount(app: RPCMountTarget, prefix?: string): void {
    if (prefix) {
      this.basePath = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    }
    const route = `${this.basePath}/*path`;
    const handler = (request: Request): Promise<Response> => this.handle(request);
    app.get(route, handler);
    app.post(route, handler);
  }

  private flattenRoutes(routes: RouterDefinition, prefix: string): void {
    for (const [key, value] of Object.entries(routes)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (this.isProcedure(value)) {
        this.flatRoutes.set(path, value as ProcedureDefinition);
      } else {
        this.flattenRoutes(value as RouterDefinition, path);
      }
    }
  }

  private isProcedure(value: unknown): value is ProcedureDefinition {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      "handler" in value &&
      ((value as ProcedureDefinition).type === "query" || (value as ProcedureDefinition).type === "mutation")
    );
  }

  /** Whether the introspection endpoints may be served in this process. */
  private introspectionEnabled(): boolean {
    if (this.introspection === "development") return !isProductionEnv();
    return this.introspection;
  }

  /**
   * Reject cross-origin state-changing requests (CSRF).
   *
   * `multipart/form-data`, `application/x-www-form-urlencoded`, and `text/plain`
   * are CORS-*simple*, so a cross-origin `<form method="post">` reaches the
   * handler with the victim's cookies and without a preflight. The
   * `mutation → POST` check is no defense: the attacker's form uses POST.
   *
   * Returns `null` when the request is allowed.
   */
  private checkOrigin(request: Request, url: URL): Response | null {
    if (!this.originCheck) return null;

    const origin = request.headers.get("origin");
    if (origin !== null) {
      if (origin === url.origin || this.allowedOrigins.has(origin)) return null;
      return this.errorResponse(403, "CROSS_ORIGIN_DENIED", "Cross-origin request rejected");
    }

    // No Origin header: browsers still label the request via Sec-Fetch-Site.
    // "none" means user-initiated (address bar); "same-origin" is our own page.
    const site = request.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") {
      return this.errorResponse(403, "CROSS_ORIGIN_DENIED", "Cross-origin request rejected");
    }

    // Neither header, not a browser (curl, server-to-server, native client),
    // so there are no ambient cookies for an attacker to ride.
    return null;
  }

  /**
   * Parse a non-GET body. Requires `application/json` unless the procedure
   * explicitly opted in to form bodies via `.allowFormData()`; requiring JSON
   * forces a CORS preflight, which a cross-origin `<form>` cannot satisfy.
   *
   * Returns a `Response` on failure, otherwise the decoded input.
   */
  private async parseBody(request: Request, proc: ProcedureDefinition): Promise<Response | { input: unknown }> {
    // Prefer pre-parsed body from CelsianApp (body stream already consumed)
    const preParsed = (request as unknown as Record<string, unknown>).parsedBody;
    const contentType = request.headers.get("content-type") ?? "";
    const essence = mimeEssence(contentType);
    const isForm = FORM_CONTENT_TYPES.includes(essence);

    if (isForm) {
      if (!proc.allowFormData) {
        return this.errorResponse(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Form-encoded bodies are not accepted. Send application/json, or enable .allowFormData() on this procedure.",
        );
      }
      return { input: preParsed instanceof FormData ? preParsed : await request.formData() };
    }

    // text/plain is CORS-simple too, and an empty content-type would otherwise
    // reach a no-input mutation. Anything that is not JSON is refused.
    if (!isJsonEssence(essence)) {
      return this.errorResponse(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        `Expected content-type application/json, received "${contentType || "none"}".`,
      );
    }

    try {
      const body = preParsed !== undefined ? preParsed : await request.json();
      return { input: decode(body) };
    } catch {
      return this.errorResponse(400, "PARSE_ERROR", "Invalid JSON body");
    }
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rpcPathRegex = new RegExp(`^${this.basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
    const rpcPath = url.pathname.replace(rpcPathRegex, "");

    if (rpcPath === "openapi.json" || rpcPath === "manifest.json") {
      return this.serveIntrospection(rpcPath, request);
    }

    const proc = this.flatRoutes.get(rpcPath);
    if (!proc) {
      return this.errorResponse(404, "NOT_FOUND", `Procedure "${rpcPath}" not found`);
    }

    if (proc.type === "mutation" && request.method !== "POST") {
      return this.errorResponse(405, "METHOD_NOT_ALLOWED", "Mutations require POST");
    }

    // Anything that is not a GET query counts as state-changing: `query`
    // procedures are invokable over POST too, so the verb carries no security
    // meaning on its own.
    if (proc.type === "mutation" || request.method !== "GET") {
      const denied = this.checkOrigin(request, url);
      if (denied) return denied;
    }

    // Parse input
    let rawInput: unknown;
    if (request.method === "GET") {
      const inputParam = url.searchParams.get("input");
      if (inputParam) {
        try {
          rawInput = decode(JSON.parse(inputParam));
        } catch {
          return this.errorResponse(400, "PARSE_ERROR", "Invalid input parameter");
        }
      }
    } else {
      const parsed = await this.parseBody(request, proc);
      if (parsed instanceof Response) return parsed;
      rawInput = parsed.input;
    }

    // Validate input. A schema adapter can throw (a misconfigured or async
    // schema), so this is inside the same error mapping as the handler,
    // otherwise the rejection escapes handle() entirely.
    let ctx: RPCContext;
    try {
      if (proc.inputSchema) {
        const result = proc.inputSchema.validate(rawInput);
        if (!result.success) {
          return this.errorResponse(400, "VALIDATION_ERROR", "Input validation failed", result.issues);
        }
        rawInput = result.data;
      }

      // Build context
      ctx = await this.contextFactory(request);
    } catch (error) {
      return this.handleError(error, rpcPath);
    }

    // Run middleware chain + handler
    try {
      const output = await this.runProcedure(proc, rawInput, ctx);

      if (proc.outputSchema) {
        const result = proc.outputSchema.validate(output);
        if (!result.success) {
          return this.errorResponse(500, "OUTPUT_VALIDATION_ERROR", "Output validation failed");
        }
      }

      const response: RPCResponse = { result: encode(output) };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      return this.handleError(error, rpcPath);
    }
  }

  /**
   * Serve `openapi.json` / `manifest.json`, gated by the `introspection` option
   * and guarded by `introspectionMiddlewares`.
   *
   * When disabled these 404 exactly like an unknown procedure, so a probe
   * cannot distinguish "introspection is off" from "no such route".
   */
  private async serveIntrospection(rpcPath: string, request: Request): Promise<Response> {
    if (!this.introspectionEnabled()) {
      return this.errorResponse(404, "NOT_FOUND", `Procedure "${rpcPath}" not found`);
    }

    if (this.introspectionMiddlewares.length > 0) {
      const ctx = await this.contextFactory(request);
      try {
        await this.runChain(this.introspectionMiddlewares, ctx, async () => undefined);
      } catch (error) {
        return this.handleError(error, rpcPath);
      }
    }

    const payload = rpcPath === "openapi.json" ? this.generateOpenAPI() : this.getManifest();
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    });
  }

  /** Shared error → Response mapping for procedures and introspection guards. */
  private handleError(error: unknown, rpcPath: string): Response {
    const status = (error as { statusCode?: number }).statusCode ?? 500;

    // Always log unexpected errors server-side so operators keep full detail
    // even when the client-facing message is sanitized below. Routed through
    // the configured logger (default: console.error) so it inherits the app
    // logger's redaction, levels, and sinks when one is supplied.
    if (status >= 500) {
      this.logger.error(`[@celsian/rpc] procedure "${rpcPath}" error`, {
        err: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
      });
    }

    // In production, unexpected (5xx-equivalent) errors must not leak
    // internals, raw error messages/codes can disclose stack details, file
    // paths, or query fragments. Mirrors @celsian/core's error-handler
    // sanitization. Intentional HTTP-style errors (statusCode < 500, e.g.
    // thrown HttpErrors) pass through unchanged.
    if (isProductionEnv() && status >= 500) {
      return this.errorResponse(status, "INTERNAL_ERROR", "Internal error");
    }

    const message = error instanceof Error ? error.message : "Internal error";
    const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
    return this.errorResponse(status, code, message);
  }

  private async runProcedure(proc: ProcedureDefinition, input: unknown, ctx: RPCContext): Promise<unknown> {
    return this.runChain(proc.middlewares, ctx, () => proc.handler({ input, ctx }));
  }

  private async runChain(
    middlewares: MiddlewareFunction[],
    ctx: RPCContext,
    terminal: () => Promise<unknown>,
  ): Promise<unknown> {
    let index = 0;

    const next = async (): Promise<unknown> => {
      if (index < middlewares.length) {
        const mw = middlewares[index++]!;
        return mw({ ctx, next });
      }
      return terminal();
    };

    return next();
  }

  private errorResponse(
    status: number,
    code: string,
    message: string,
    issues?: Array<{ message: string; path?: (string | number)[] }>,
  ): Response {
    const response: RPCResponse = {
      error: { message, code, issues },
    };
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  getManifest(): RPCManifest {
    const procedures: RPCManifest["procedures"] = {};
    for (const [path, proc] of this.flatRoutes) {
      procedures[path] = {
        type: proc.type,
        path,
        inputSchema: proc.inputSchema?.toJsonSchema(),
        outputSchema: proc.outputSchema?.toJsonSchema(),
      };
    }
    return { procedures };
  }

  generateOpenAPI(info?: { title?: string; version?: string; description?: string }) {
    return generateOpenAPI(this.flatRoutes, info, this.basePath);
  }

  getRoutes(): Map<string, ProcedureDefinition> {
    return this.flatRoutes;
  }
}
