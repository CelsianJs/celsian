---
"@celsian/core": patch
"@celsian/cache": patch
"@celsian/adapter-node": patch
---

Preserve stream ownership from request to transport. SSE data now handles CR,
CRLF and LF safely, and cancelled or pre-aborted subscriptions release hub
membership and timers. Node response writers respect backpressure, cancel idle
producers on disconnect, and retain transport cancellation alongside request
timeouts. The Node adapter shares the core HTTP conversion implementation.

Response cache keys preserve the order of repeated query parameters while still
normalizing distinct parameter names. Hashed entries retain their full logical
key so invalidation works for long paths, including across cache instances.

**Upgrade note:** clear or rebuild existing persistent response-cache entries
when deploying this release. Previous entries may have collapsed repeated-query
ordering or lack the identity metadata needed to invalidate long hashed keys;
their original identity cannot be reconstructed. Invalidation of hashed entries
now reads stored metadata, which adds KV reads; ordinary short-key cache hits do
not add a metadata lookup.
