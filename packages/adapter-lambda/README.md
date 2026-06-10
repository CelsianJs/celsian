# CelsianJS AWS Lambda Adapter

Run CelsianJS apps on AWS Lambda. Supports API Gateway **v2 (HTTP API)**, **v1 (REST API)**, and **Application Load Balancer** events — the adapter auto-detects the event shape.

Part of the [CelsianJS](https://github.com/CelsianJs/celsian) monorepo. See the root README for full framework docs.

## Installation

```bash
npm install @celsian/core @celsian/adapter-lambda
```

## Usage

```ts
// handler.ts
import { createApp } from '@celsian/core';
import { createLambdaHandler } from '@celsian/adapter-lambda';

const app = createApp();
app.get('/hello/:name', (req, reply) => reply.json({ hello: req.params.name }));

export const handler = createLambdaHandler(app);
```

Request cookies (`event.cookies` on v2) and binary bodies (base64) are decoded
correctly; binary responses are automatically base64-encoded with
`isBase64Encoded: true`.

## Serverless note

Lambda functions are short-lived, so `app.task()` workers and `app.cron()`
schedulers do **not** run in this environment. Use a durable queue
(`@celsian/queue-redis`) processed by a long-running worker, and platform-native
scheduling (EventBridge) for cron. See the root deployment docs.

## License

MIT
