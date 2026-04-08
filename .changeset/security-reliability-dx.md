---
"@celsian/core": patch
"@celsian/rate-limit": patch
"@celsian/cache": patch
"@celsian/compress": patch
"@celsian/edge-router": patch
"@celsian/jwt": patch
"celsian": patch
---

Security, reliability, and DX improvements from comprehensive product audit.

**Security**: Rate limiter uses rightmost XFF IP and throws when disabled. Edge router blocks SSRF to internal IPs, prevents ReDoS, validates route patterns. CORS throws on wildcard+credentials. Redirect validates URLs. Body parsing stream-limits chunked requests.

**Reliability**: Structured logging for fire-and-forget hooks. SSE auto-close for stale channels. Cron/rate-limit timers unref'd. Task worker stop has deadline. WebSocket upgrade auth callback.

**DX**: `TypedRouteOptions` for typed `parsedBody` in `app.route()`. Cache key Vary header support.
