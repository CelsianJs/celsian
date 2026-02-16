// @celsian/server — JWT authentication middleware plugin

import type { PluginFunction, HookHandler, CelsianRequest } from '../types.js';
import { fp } from '../types.js';

export interface JwtAuthOptions {
  /** Secret key for HMAC-SHA256 verification */
  secret?: string;
  /** Custom token extractor (default: Bearer token from Authorization header) */
  extractToken?: (request: Request) => string | null;
  /** Paths to exclude from auth (exact match or prefix with trailing *) */
  exclude?: string[];
  /** Custom verify function (for external JWT libraries) */
  verify?: (token: string) => Promise<JwtPayload | null>;
  /** Custom unauthorized response */
  onUnauthorized?: (request: Request) => Response;
}

export interface JwtPayload {
  sub?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

function defaultExtractToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

function isExcluded(pathname: string, exclude: string[]): boolean {
  for (const pattern of exclude) {
    if (pattern.endsWith('*')) {
      if (pathname.startsWith(pattern.slice(0, -1))) return true;
    } else {
      if (pathname === pattern) return true;
    }
  }
  return false;
}

/**
 * Decode a JWT payload WITHOUT cryptographic verification.
 * For production, use the `verify` option with a proper JWT library.
 * This is a minimal built-in decoder for simple use cases with HMAC.
 */
function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = parts[1]!;
    // Base64url decode
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Simple HMAC-SHA256 JWT verification using Web Crypto API.
 */
async function verifyHmacSha256(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts as [string, string, string];

  // Import the secret key
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  // Sign the header.payload
  const data = encoder.encode(`${header}.${payload}`);
  const signatureBytes = await crypto.subtle.sign('HMAC', key, data);

  // Compare signatures
  const expectedSig = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  if (expectedSig !== signature) return null;

  // Decode payload
  const decoded = decodeJwtPayload(token);
  if (!decoded) return null;

  // Check expiration
  if (decoded.exp && decoded.exp * 1000 < Date.now()) return null;

  return decoded;
}

/**
 * JWT authentication middleware plugin.
 *
 * Usage:
 * ```ts
 * app.register(jwtAuth, {
 *   secret: process.env.JWT_SECRET,
 *   exclude: ['/api/health', '/api/auth/*'],
 * });
 * ```
 */
export const jwtAuth: PluginFunction = fp(async (app, options) => {
  const opts = options as JwtAuthOptions;
  const extractToken = opts.extractToken ?? defaultExtractToken;
  const exclude = opts.exclude ?? [];
  const onUnauthorized = opts.onUnauthorized;
  const verifyFn = opts.verify ?? (opts.secret ? (token: string) => verifyHmacSha256(token, opts.secret!) : null);

  if (!verifyFn) {
    throw new Error('[jwtAuth] Either "secret" or "verify" option is required');
  }

  const authHook: HookHandler = async (request, reply) => {
    const url = new URL(request.url);

    // Check exclusions
    if (isExcluded(url.pathname, exclude)) return;

    // Extract token
    const token = extractToken(request);
    if (!token) {
      if (onUnauthorized) return onUnauthorized(request);
      return reply.status(401).json({
        error: 'Unauthorized',
        statusCode: 401,
        message: 'Missing authentication token',
      });
    }

    // Verify token
    const payload = await verifyFn(token);
    if (!payload) {
      if (onUnauthorized) return onUnauthorized(request);
      return reply.status(401).json({
        error: 'Unauthorized',
        statusCode: 401,
        message: 'Invalid or expired token',
      });
    }

    // Attach user to request
    (request as CelsianRequest).user = payload;
  };

  // Also decorate request with user property type
  app.decorateRequest('user', null);
  app.addHook('onRequest', authHook);
});
