---
"celsian": minor
---

Re-export all of `@celsian/core`, and stop depending on `@celsian/rpc` and `@celsian/cli`.

The umbrella package carried a hand-maintained export list that had drifted to 33
of core's 65 exports, so `celsian.upload` and `celsian.createSSEHub` were
`undefined` despite both being documented in the core README, and every feature
added to core since that list was last touched was unreachable through `celsian`.
It now re-exports `@celsian/core` and `@celsian/schema` wholesale, so it cannot
drift again.

`@celsian/rpc` and `@celsian/cli` are no longer runtime dependencies. They were
never re-exported, so they could not be reached through `celsian` anyway: they
only added download weight, and `@celsian/cli` is a development tool that has no
business in a runtime dependency tree. Both remain available as their own
installs, which is what the README already told you to do.
