import type { CorsConfig } from './types.js';

/**
 * Check if an origin is allowed by the CORS config.
 */
export function isOriginAllowed(origin: string, config: CorsConfig): boolean {
  if (typeof config.origin === 'string') {
    return config.origin === '*' || config.origin === origin;
  }
  if (Array.isArray(config.origin)) {
    return config.origin.includes(origin);
  }
  if (typeof config.origin === 'function') {
    return config.origin(origin);
  }
  return false;
}

/**
 * Build CORS headers for a given origin.
 */
export function corsHeaders(origin: string, config: CorsConfig): Record<string, string> {
  const headers: Record<string, string> = {};

  if (!isOriginAllowed(origin, config)) return headers;

  const isWildcard = typeof config.origin === 'string' && config.origin === '*';
  headers['Access-Control-Allow-Origin'] = isWildcard ? '*' : origin;

  // Per CORS spec, credentials are invalid with wildcard origin
  if (config.credentials && !isWildcard) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  // When the resolved origin is specific (not *), add Vary: Origin
  if (!isWildcard) {
    headers['Vary'] = 'Origin';
  }

  if (config.exposeHeaders?.length) {
    headers['Access-Control-Expose-Headers'] = config.exposeHeaders.join(', ');
  }

  return headers;
}

/**
 * Build a preflight (OPTIONS) response for CORS.
 */
export function preflightResponse(origin: string, config: CorsConfig): Response {
  const headers: Record<string, string> = corsHeaders(origin, config);

  const methods = config.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
  headers['Access-Control-Allow-Methods'] = methods.join(', ');

  const allowHeaders = config.allowHeaders ?? ['Content-Type', 'Authorization'];
  headers['Access-Control-Allow-Headers'] = allowHeaders.join(', ');

  if (config.maxAge !== undefined) {
    headers['Access-Control-Max-Age'] = String(config.maxAge);
  }

  return new Response(null, { status: 204, headers });
}
