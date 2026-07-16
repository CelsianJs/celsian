# @celsian/adapter-cloudflare

## 0.5.5

### Patch Changes

- Updated dependencies [d574a13]
  - @celsian/core@0.5.5

## 0.5.4

### Patch Changes

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
