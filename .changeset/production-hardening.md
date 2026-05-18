---
"@celsian/core": minor
"@celsian/rate-limit": patch
"@celsian/jwt": patch
"@celsian/cache": patch
"@celsian/adapter-lambda": patch
"@celsian/cli": minor
"@celsian/platform": minor
"@celsian/adapter-bun": minor
"@celsian/adapter-deno": minor
"@celsian/ws-redis": minor
---

Production hardening release: security fixes (rate-limit IP spoofing, JWT secret scoping, session regeneration, lambda proto validation, error stack guards), app.ts decomposition into body-parser and error-handler modules, file upload plugin, Bun and Deno adapters, ws-redis distributed WebSocket, deploy command with platform auto-detection, integration and stress tests, Fastify migration guide.
