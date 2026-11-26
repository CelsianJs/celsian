---
"@celsian/adapter-node": patch
"@celsian/core": patch
---

`@celsian/adapter-node`'s `serve({ staticDir })` no longer serves files outside `staticDir` through a symlink. A link inside the directory that pointed out of it (for example `public/avatar.png -> ../.env`) was returned with a 200. Core's `serve()` was fixed for this in 0.6.0; the adapter had its own copy of the static-file code without the fix. It now uses the same confined reader as core, so such a request falls through to the app's routes. Symlinks that stay inside `staticDir` are still served.

`@celsian/core` now exports that reader, `readConfinedFile`, with its `ConfinedRead` and `SendFileOptions` types.
