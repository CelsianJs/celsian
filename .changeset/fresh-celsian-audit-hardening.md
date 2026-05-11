---
"@celsian/core": patch
"@celsian/adapter-node": patch
"@celsian/queue-redis": patch
---

Preserve security headers on core error responses, preserve multiple Set-Cookie headers in the Node adapter, stream static assets, and restore expired Redis in-flight messages after their visibility timeout.
