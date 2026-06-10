// @celsian/core — CORS plugin

import { CelsianError } from "../errors.js";
import type { HookHandler, PluginFunction } from "../types.js";

export interface CORSOptions {
  origin?: string | string[] | ((origin: string) => boolean);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

const DEFAULTS: Required<CORSOptions> = {
  origin: "*",
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

/** Append "Origin" to an existing Vary header value (no duplicates). */
function appendVaryOrigin(existing: string | undefined): string {
  if (!existing) return "Origin";
  const parts = existing.split(",").map((v) => v.trim().toLowerCase());
  if (parts.includes("origin") || parts.includes("*")) return existing;
  return `${existing}, Origin`;
}

export function cors(options: CORSOptions = {}): PluginFunction {
  const opts = { ...DEFAULTS, ...options };

  // When the allowed origin is reflected (string/array/function) rather than the
  // literal "*", responses differ per Origin — caches MUST be told via Vary: Origin
  // or a CDN can serve one origin's CORS headers to another (cache poisoning).
  const varyByOrigin = opts.origin !== "*";

  if (opts.origin === "*" && opts.credentials) {
    throw new CelsianError(
      'CORS misconfiguration: origin "*" with credentials:true is forbidden by browsers. ' +
        "Set a specific origin (e.g., 'http://localhost:3000') when credentials are enabled.",
    );
  }

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
          return new Response(null, {
            status: 204,
            headers: varyByOrigin ? { vary: "Origin" } : undefined,
          });
        }

        const headers: Record<string, string> = {};
        if (varyByOrigin) headers.vary = "Origin";
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

      // Response varies by Origin even when this particular origin is rejected
      // (a different origin would get CORS headers) — always mark it for caches.
      if (varyByOrigin) {
        reply.header("vary", appendVaryOrigin(reply.headers.vary));
      }

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
