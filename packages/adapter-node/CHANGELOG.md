# @celsian/adapter-node

## 0.5.4

### Patch Changes

- 74898eb: Fail loud instead of silently pretending to work (framework-wide silent-failure sweep):

  - **@celsian/schema**: `fromValibot()` now validates modern Valibot schemas (>=0.31, incl. 1.x) through the Standard Schema `~standard.validate()` contract. Previously it only tried the legacy `_parse`/`safeParse` methods — which modern Valibot no longer exposes — so every validation silently failed with a generic "Unknown valibot schema format" issue, rejecting valid input with no field-level detail. Async Valibot schemas now fail with a clear, explicit error instead of leaking a dangling Promise.
  - **@celsian/adapter-node**: the vestigial `nodeAdapter.buildEnd()` build hook now throws a clear not-implemented error directing callers to the runtime `serve()` export, instead of logging "Generated server entry" while writing nothing to disk.
  - @celsian/core@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies [a60b3e4]
  - @celsian/core@0.5.3

## 0.5.2

### Patch Changes

- 05eb2b4: Serverless adapter fidelity and edge-compatibility fixes:

  - **adapter-lambda**: forward API Gateway v2 `event.cookies` as the `cookie` request header (handlers previously saw no cookies); pass base64-encoded bodies through as raw bytes instead of corrupting binary payloads via utf-8 decoding; support API Gateway v1 (REST API) and ALB events with shape detection, multiValueHeaders/multiValueQueryStringParameters merging, and v1/ALB response formats (including `multiValueHeaders` set-cookie handling).
  - **adapter-vercel**: remove the module-level `node:crypto` import that broke edge bundling (`esbuild --platform=neutral`); the cron handler's timing-safe secret comparison now uses Web Crypto (`crypto.subtle`), keeping `createVercelEdgeHandler` bundleable for edge runtimes.
  - **adapter-cloudflare**: `createCloudflareHandler(app)` now also returns a `scheduled` handler that bridges Cloudflare Cron Triggers to `app.cron()` jobs (matching by cron expression, falling back to all jobs when a single trigger drives them); existing `fetch`-only usage keeps working.
  - **adapter-bun**: document that `server.upgrade()` runs before route hooks (JWT guards/rate limiting do not apply to WS upgrades) and show the `open`-handler auth pattern.
  - **adapter-node**: fix stale `then.config.ts` reference in the README (now `celsian.config.ts`).

- Updated dependencies [05eb2b4]
  - @celsian/core@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [0c69589]
  - @celsian/core@0.5.1

## 0.3.19

### Patch Changes

- Updated dependencies [dec80a7]
  - @celsian/core@0.4.0

## 0.3.16

### Patch Changes

- Updated dependencies
  - @celsian/core@0.3.16

## 0.3.1

### Patch Changes

- Updated dependencies [5d0dc35]
  - @celsian/core@0.3.3
