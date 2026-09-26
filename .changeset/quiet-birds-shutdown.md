---
"@celsian/core": patch
---

Close long-lived SSE and WebSocket connections during Node `serve()` shutdown so open streams do not keep processes alive after the grace period.
