---
"@celsian/core": patch
"@celsian/cli": patch
"@celsian/jwt": patch
"@celsian/ws-redis": patch
"@celsian/queue-redis": patch
---

Production-readiness DX fixes and dependency maintenance (0.5.3).

- **@celsian/core (fail-loud config):** `loadConfig()` no longer swallows a broken `celsian.config.*` with a bare `catch`. A genuinely absent config still falls back to defaults, but a config that exists and fails to load (syntax/runtime error, or a missing import it depends on) now throws the new exported `ConfigLoadError` naming the file and cause. `serve()` surfaces it instead of silently binding defaults — fixing the "why won't my config apply" black hole where a typo in the config left the server on port 3000 with no diagnostic.
- **@celsian/cli (`celsian dev`):** checks the entry file exists before spawning `tsx`, printing `Entry file not found: <entry>` plus usage (mirroring `celsian routes`) instead of a raw "Cannot find module" stack trace on first run.
- **@celsian/cli (`celsian generate rpc`):** now scaffolds a mountable, type-correct starting point — wrapped in `router()`, exported as a registerable `PluginFunction` that calls `new RPCHandler(...).mount(app)`, with `.input(schema)` guidance — instead of a bare object that had no path to a live endpoint and destructured an always-`undefined` `input`.
- **@celsian/jwt:** bump `jose` `5.10.0` → `6.2.2` (major). No API changes; sign/verify/expiry/algorithm selection and cross-app guard isolation are all covered by the existing jwt test suite under jose 6.
- **@celsian/ws-redis, @celsian/queue-redis:** bump `ioredis` `5.9.3` → `5.11.1` (minor).
