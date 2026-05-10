// @celsian/core — CORS plugin

import type { HookHandler, PluginFunction } from "../types.js";

export interface CORSOptions {
  /**
   * Allowed origin(s). Required — no default wildcard.
   * Pass a string, array of strings, or a function for dynamic matching.
   * Use `"*"` only for truly public APIs with no credentials.
   */
  origin: string | string[] | ((origin: string) => boolean);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

const DEFAULTS: Omit<Required<CORSOptions>, "origin"> = {
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
  allowedHeaders: [],
  exposedHeaders: [],
  credentials: false,
  maxAge: 0,
};

function isOriginAllowed(requestOrigin: string, option: CORSOptions["origin"]): boolean {
  if (option === "*") return true;
  if (typeof option === "string") return requestOrigin === option;
  if (Array.isArray(option)) return option.includes(requestOrigin);
  if (typeof option === "function") return option(requestOrigin);
  return false;
}

function resolveOriginHeader(origin: string, opts: Required<CORSOptions>): string {
  if (!isOriginAllowed(origin, opts.origin)) return "";
  return opts.origin === "*" && !opts.credentials ? "*" : origin;
}

export function cors(options: CORSOptions): PluginFunction {
  if (!options || options.origin === undefined) {
    throw new Error(
      "[celsian] CORS origin is required. Pass an explicit origin (e.g. 'http://localhost:3000') " +
        "or '*' for public APIs. Wildcard '*' is incompatible with credentials:true.",
    );
  }
  if (options.origin === "*" && options.credentials) {
    throw new Error(
      "[celsian] CORS origin '*' is incompatible with credentials:true. " +
        "Browsers will reject Set-Cookie headers when the CORS origin is a wildcard. " +
        "Set origin to a specific value.",
    );
  }
  const opts = { ...DEFAULTS, ...options };

  return function corsPlugin(app) {
    // Register catch-all OPTIONS route for preflight
    app.route({
      method: "OPTIONS",
      url: "/*path",
      handler(request, _reply) {
        const origin = request.headers.get("origin") ?? "";
        const allowOrigin = resolveOriginHeader(origin, opts);

        // Don't leak CORS headers to disallowed origins
        if (!allowOrigin) {
          return new Response(null, { status: 204 });
        }

        const headers: Record<string, string> = {};
        headers["access-control-allow-origin"] = allowOrigin;
        headers["access-control-allow-methods"] = opts.methods.join(", ");

        if (opts.allowedHeaders.length > 0) {
          headers["access-control-allow-headers"] = opts.allowedHeaders.join(", ");
        } else {
          const requestedHeaders = request.headers.get("access-control-request-headers");
          if (requestedHeaders) {
            headers["access-control-allow-headers"] = requestedHeaders;
          }
        }

        if (opts.credentials) {
          headers["access-control-allow-credentials"] = "true";
        }

        if (opts.maxAge > 0) {
          headers["access-control-max-age"] = String(opts.maxAge);
        }

        return new Response(null, { status: 204, headers });
      },
    });

    // Actual request CORS headers
    const sendHook: HookHandler = (request, reply) => {
      const origin = request.headers.get("origin") ?? "";
      const allowOrigin = resolveOriginHeader(origin, opts);

      // Don't set any CORS headers for disallowed origins
      if (!allowOrigin) return;

      reply.header("access-control-allow-origin", allowOrigin);

      if (opts.credentials) {
        reply.header("access-control-allow-credentials", "true");
      }

      if (opts.exposedHeaders.length > 0) {
        reply.header("access-control-expose-headers", opts.exposedHeaders.join(", "));
      }
    };
    app.addHook("onSend", sendHook);
  };
}
