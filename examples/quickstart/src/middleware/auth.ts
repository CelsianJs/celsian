// Auth guard middleware — protects routes that require a valid JWT.
//
// Uses @celsian/jwt's createJWTGuard, which:
//   1. Extracts the Bearer token from the Authorization header
//   2. Verifies and decodes it
//   3. Attaches the payload to `request.user`
//   4. Returns 401 if the token is missing or invalid
//
// The JWT plugin is registered in src/index.ts. This module exports
// the shared secret and a getJwt() helper for signing tokens.

import { createJWTGuard, type JWTNamespace } from "@celsian/jwt";

// In production, load this from an environment variable or secrets manager.
const DEFAULT_JWT_SECRET = "quickstart-dev-secret";
export const JWT_SECRET = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET;

if (process.env.NODE_ENV === "production" && JWT_SECRET === DEFAULT_JWT_SECRET) {
  throw new Error("Set JWT_SECRET to a strong, unique secret before running quickstart in production");
}

// Re-usable hook — attach to any route via `preHandler: authGuard`
export const authGuard = createJWTGuard({ secret: JWT_SECRET });

// ─── Shared JWT Instance ───
// Set by index.ts after the jwt plugin registers. Accessible after app.ready().

let _jwt: JWTNamespace | null = null;

export function setJwtInstance(instance: JWTNamespace) {
  _jwt = instance;
}

export function getJwt(): JWTNamespace {
  if (!_jwt) throw new Error("JWT not initialized — ensure app.ready() was awaited");
  return _jwt;
}
