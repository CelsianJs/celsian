// @celsian/server — CORS middleware plugin

import type { PluginFunction, HookHandler } from '../types.js';
import { fp } from '../types.js';

export interface CorsOptions {
  /** Allowed origins. Use '*' for all, or provide specific origins/regex patterns */
  origin?: string | string[] | RegExp | ((origin: string) => boolean);
  /** Allowed HTTP methods */
  methods?: string[];
  /** Allowed headers */
  allowedHeaders?: string[];
  /** Headers exposed to the client */
  exposedHeaders?: string[];
  /** Allow credentials (cookies, auth headers) */
  credentials?: boolean;
  /** Max age for preflight cache (seconds) */
  maxAge?: number;
  /** Handle preflight OPTIONS automatically */
  preflight?: boolean;
}

const DEFAULT_CORS: Required<CorsOptions> = {
  origin: '*',
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  allowedHeaders: [],
  exposedHeaders: [],
  credentials: false,
  maxAge: 5,
  preflight: true,
};

function isOriginAllowed(
  requestOrigin: string,
  allowed: CorsOptions['origin'],
): boolean {
  if (allowed === '*') return true;
  if (typeof allowed === 'string') return requestOrigin === allowed;
  if (allowed instanceof RegExp) return allowed.test(requestOrigin);
  if (Array.isArray(allowed)) return allowed.includes(requestOrigin);
  if (typeof allowed === 'function') return allowed(requestOrigin);
  return false;
}

/**
 * Build the CORS hook handler from options.
 */
export function buildCorsHook(options?: CorsOptions): HookHandler {
  const opts = { ...DEFAULT_CORS, ...options } as Required<CorsOptions>;

  return async (request, reply) => {
    const origin = request.headers.get('origin') ?? '';
    const method = request.method;

    // Determine the effective origin header value
    let originHeader: string;
    if (opts.origin === '*' && !opts.credentials) {
      originHeader = '*';
    } else if (isOriginAllowed(origin, opts.origin)) {
      originHeader = origin;
    } else {
      // Origin not allowed — skip CORS headers
      return;
    }

    // Set CORS headers
    reply.header('access-control-allow-origin', originHeader);

    if (opts.credentials) {
      reply.header('access-control-allow-credentials', 'true');
    }

    if (opts.exposedHeaders.length > 0) {
      reply.header('access-control-expose-headers', opts.exposedHeaders.join(', '));
    }

    // Handle preflight
    if (opts.preflight && method === 'OPTIONS') {
      reply.header('access-control-allow-methods', opts.methods.join(', '));

      if (opts.allowedHeaders.length > 0) {
        reply.header('access-control-allow-headers', opts.allowedHeaders.join(', '));
      } else {
        const requestedHeaders = request.headers.get('access-control-request-headers');
        if (requestedHeaders) {
          reply.header('access-control-allow-headers', requestedHeaders);
        }
      }

      if (opts.maxAge > 0) {
        reply.header('access-control-max-age', String(opts.maxAge));
      }

      return reply.status(204).send(null);
    }
  };
}

/**
 * CORS middleware plugin for CelsianApp.
 *
 * Usage:
 * ```ts
 * // As a plugin (scoped to the encapsulation context)
 * await app.register(cors, { origin: 'https://example.com' });
 *
 * // Or add hook directly to the app (affects all routes)
 * app.addHook('onRequest', buildCorsHook({ origin: '*' }));
 * ```
 */
export const cors: PluginFunction = fp(async (app, options) => {
  app.addHook('onRequest', buildCorsHook(options as CorsOptions));
});
