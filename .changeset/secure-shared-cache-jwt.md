---
"@celsian/cache": patch
"@celsian/core": patch
"@celsian/jwt": patch
"celsian": patch
---

Prevent cross-user response disclosure by bypassing the shared response cache
for credentialed requests, partitioning reflected CORS responses by Origin,
refusing `no-cache`, zero-age, and private responses, and storing only `Vary`
responses whose request fields are represented in the cache key. Remove the module-global
JWT guard fallback so no-argument guards resolve secrets and algorithms only
from the current app's request.
