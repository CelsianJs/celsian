# @celsian/cli

## 0.4.0

### Minor Changes

- dec80a7: Production hardening release: security fixes (rate-limit IP spoofing, JWT secret scoping, session regeneration, lambda proto validation, error stack guards), app.ts decomposition into body-parser and error-handler modules, file upload plugin, Bun and Deno adapters, ws-redis distributed WebSocket, deploy command with platform auto-detection, integration and stress tests, Fastify migration guide.

### Patch Changes

- Updated dependencies [dec80a7]
  - @celsian/core@0.4.0

## 0.3.18

### Patch Changes

- Republish the CLI version-display fix with resolved package dependencies after `0.3.17` was deprecated for unresolved `workspace:*` metadata.

## 0.3.17

### Patch Changes

- e2133f8: Fix the CLI banner/version output so registry-installed `celsian --help` reports the package manifest version instead of the stale hard-coded `0.1.0` string.

## 0.3.16

### Patch Changes

- Updated dependencies
  - @celsian/core@0.3.16

## 0.3.3

### Patch Changes

- Updated dependencies [5d0dc35]
  - @celsian/core@0.3.3
