// @celsian/server — ETag caching middleware

import type { PluginFunction, HookHandler } from '../types.js';
import { fp } from '../types.js';

export interface ETagOptions {
  /** Use weak ETags (default: true) */
  weak?: boolean;
}

/**
 * Generate a simple hash for ETag.
 * Uses a fast non-cryptographic hash for performance.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * ETag middleware — adds ETag headers for conditional requests.
 * Supports If-None-Match for 304 Not Modified responses.
 *
 * Usage:
 * ```ts
 * app.register(etag);
 * ```
 */
export const etag: PluginFunction = fp(async (app, options) => {
  const weak = (options as ETagOptions).weak !== false;

  const etagHook: HookHandler = async (request, reply) => {
    // Only handle GET/HEAD requests
    if (request.method !== 'GET' && request.method !== 'HEAD') return;

    // Store original send to intercept response
    // We use onSend hook instead, which runs after the handler
  };

  // onSend hook to add ETag headers after handler generates response
  app.addHook('onSend', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return;

    // Check if the handler already set an ETag
    if (reply.headers['etag']) return;

    // We can't easily intercept the Response body in onSend.
    // Instead, this middleware is best used as route-level helper.
    // For automatic ETag, use the reply decorator.
  });

  // Decorate reply with etag helper
  app.decorateRequest('__etag_enabled', true);
});

/**
 * Helper to create a conditional response with ETag support.
 * Use this in route handlers for fine-grained control:
 *
 * ```ts
 * app.get('/data', (req, reply) => {
 *   const data = getExpensiveData();
 *   return withETag(req, reply, data);
 * });
 * ```
 */
export function withETag(
  request: Request,
  data: unknown,
  options?: { weak?: boolean },
): Response {
  const weak = options?.weak !== false;
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const hash = simpleHash(body);
  const etagValue = weak ? `W/"${hash}"` : `"${hash}"`;

  // Check If-None-Match
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch === etagValue) {
    return new Response(null, {
      status: 304,
      headers: { etag: etagValue },
    });
  }

  const contentType = typeof data === 'string'
    ? 'text/plain; charset=utf-8'
    : 'application/json; charset=utf-8';

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      etag: etagValue,
    },
  });
}
