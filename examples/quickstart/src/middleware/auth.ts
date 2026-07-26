// Auth guard middleware -- protects routes that require a valid JWT.
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
// The fallback is an obvious placeholder, and at least 32 bytes so
// @celsian/jwt does not warn about a brute-forceable HMAC secret on boot.
// Generate a real one with:
//   node -e "console.log(crypto.randomBytes(32).toString('hex'))"
export const JWT_SECRET = process.env.JWT_SECRET ?? "celsian-quickstart-dev-secret-change-me";

// Re-usable hook -- attach to any route via `preHandler: authGuard`
export const authGuard = createJWTGuard({ secret: JWT_SECRET });

// ─── Shared JWT Instance ───
// Set by index.ts after the jwt plugin registers. Accessible after app.ready().

let _jwt: JWTNamespace | null = null;

export function setJwtInstance(instance: JWTNamespace) {
  _jwt = instance;
}

export function getJwt(): JWTNamespace {
  if (!_jwt) throw new Error("JWT not initialized -- ensure app.ready() was awaited");
  return _jwt;
}
