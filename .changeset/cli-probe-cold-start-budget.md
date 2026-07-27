---
"@celsian/cli": patch
---

Widen the app-probe cold-start budget from 30s to 120s.

`celsian routes` and friends load your entry through `npx tsx` in a child
process. The old 30s ceiling covered that cold start (module resolution plus a
TypeScript transpile), which is sub-second on an idle machine but was observed
timing out on a loaded CI runner or a laptop mid-build, failing an otherwise
green run. The probe exits as soon as it has answered, so a larger ceiling costs
nothing in the normal case and is only ever reached when something is genuinely
stuck.
