# Deployment Guide

CelsianJS runs on any JavaScript runtime. This guide covers deploying to each supported target.

## Node.js

The simplest deployment. Use `serve()` from `@celsian/core`, which creates an `http.createServer` under the hood.

```typescript
// server.ts
import { createApp, serve } from '@celsian/core';

const app = createApp({ logger: true });
app.get('/hello', (req, reply) => reply.json({ hello: 'world' }));

serve(app, {
  port: parseInt(process.env.PORT ?? '3000'),
  host: '0.0.0.0',
  shutdownTimeout: 15_000,
  async onShutdown() {
    // Close database connections, flush logs, etc.
  },
});
```

Build and run:

```bash
npx tsc
node dist/server.js
```

For production, use a process manager:

```bash
# PM2
pm2 start dist/server.js --name my-api

# Or Docker
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY dist/ ./dist/
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

## Bun

`serve()` auto-detects Bun and uses `Bun.serve()` internally. No code changes needed.

```bash
bun run server.ts
```

For production:

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --production
COPY src/ ./src/
EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
```

## Deno

`serve()` auto-detects Deno and uses `Deno.serve()` internally.

```bash
deno run --allow-net --allow-read server.ts
```

Or use `app.fetch` directly with Deno's native serve:

```typescript
Deno.serve({ port: 3000 }, app.fetch);
```

## Cloudflare Workers

Install the adapter:

```bash
npm install @celsian/adapter-cloudflare
```

Create the worker entry:

```typescript
// worker.ts
import { createApp } from '@celsian/core';
import { createCloudflareHandler } from '@celsian/adapter-cloudflare';

const app = createApp();

app.get('/hello', (req, reply) => {
  return reply.json({ hello: 'world' });
});

// Access Cloudflare bindings via req.env
app.get('/kv/:key', async (req, reply) => {
  const env = (req as any).env;
  const value = await env.MY_KV.get(req.params.key);
  return reply.json({ key: req.params.key, value });
});

export default createCloudflareHandler(app);
```

Configure `wrangler.toml`:

```toml
name = "my-api"
main = "worker.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

[[kv_namespaces]]
binding = "MY_KV"
id = "abc123"
```

Deploy:

```bash
npx wrangler deploy
```

### Cloudflare Execution Context

The `ExecutionContext` is attached to the request, giving you access to `waitUntil()` for background work:

```typescript
app.post('/webhook', async (req, reply) => {
  const ctx = (req as any).ctx;
  const body = req.parsedBody;

  // Process webhook in background (after response is sent)
  ctx.waitUntil(processWebhook(body));

  return reply.json({ received: true });
});
```

## AWS Lambda

Install the adapter:

```bash
npm install @celsian/adapter-lambda
```

Create the Lambda handler:

```typescript
// handler.ts
import { createApp } from '@celsian/core';
import { createLambdaHandler } from '@celsian/adapter-lambda';

const app = createApp();

app.get('/hello', (req, reply) => {
  return reply.json({ hello: 'world' });
});

export const handler = createLambdaHandler(app);
```

The adapter converts API Gateway v2 events to Web Standard `Request` objects, calls `app.handle()`, and converts the `Response` back to Lambda's expected format. Binary responses are automatically base64-encoded.

### SAM Template

```yaml
# template.yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Resources:
  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: dist/handler.handler
      Runtime: nodejs20.x
      MemorySize: 256
      Timeout: 30
      Events:
        ApiGateway:
          Type: HttpApi
          Properties:
            Path: /{proxy+}
            Method: ANY
```

Deploy:

```bash
sam build && sam deploy --guided
```

## Vercel

Install the adapter:

```bash
npm install @celsian/adapter-vercel
```

### Serverless Function (Node.js Runtime)

```typescript
// api/index.ts
import { createApp } from '@celsian/core';
import { createVercelHandler } from '@celsian/adapter-vercel';

const app = createApp();
app.get('/api/hello', (req, reply) => reply.json({ hello: 'world' }));

export default createVercelHandler(app);
```

### Edge Function

> **Note:** Serverless Functions with Fluid Compute are the preferred deployment model for most use cases. Use Edge Functions only when you need edge-location execution (e.g., geo-routing, low-latency personalization).

```typescript
// api/index.ts
import { createApp } from '@celsian/core';
import { createVercelEdgeHandler } from '@celsian/adapter-vercel';

const app = createApp();
app.get('/api/hello', (req, reply) => reply.json({ hello: 'world' }));

export default createVercelEdgeHandler(app);
export const config = { runtime: 'edge' };
```

Configure `vercel.json` to route all API requests to your handler:

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api" }
  ]
}
```

Deploy:

```bash
vercel deploy
```

## Fly.io

Install the adapter:

```bash
npm install @celsian/adapter-fly
```

The Fly adapter generates `fly.toml`, `Dockerfile`, and `.dockerignore` for you:

```typescript
// celsian.config.ts
import { defineConfig } from '@celsian/core';
import { flyAdapter } from '@celsian/adapter-fly';

export default defineConfig({
  build: {
    adapter: flyAdapter({
      appName: 'my-api',
      primaryRegion: 'iad',
      regions: ['lhr', 'nrt'],  // Multi-region
      memoryMb: 256,
      autoStop: true,
      autoStart: true,
    }),
  },
});
```

Deploy:

```bash
flyctl launch    # First time
flyctl deploy    # Subsequent deploys
```

The generated fly.toml includes health checks, concurrency limits, and machine sizing. The Dockerfile is a multi-stage build with non-root user.

## Railway

Install the adapter:

```bash
npm install @celsian/adapter-railway
```

The Railway adapter generates `railway.json`, `Procfile`, and `.env.example`:

```typescript
import { railwayAdapter } from '@celsian/adapter-railway';

const adapter = railwayAdapter({
  healthCheckPath: '/health',
});
```

Deploy:

```bash
# Railway auto-deploys on git push
git push origin main
```

Railway auto-detects Node.js via Nixpacks. The generated `railway.json` configures the start command, health check, and restart policy.

## Environment Variables

CelsianJS reads these environment variables automatically:

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | - | When `production`, stack traces are stripped from error responses |
| `CELSIAN_ENV` | - | Alternative to `NODE_ENV` for CelsianJS-specific behavior |

## Serverless Limitations

When deploying to serverless platforms (Vercel, AWS Lambda, Cloudflare Workers), be aware of these limitations:

### Background Tasks

`app.task()` and `app.enqueue()` define and dispatch background tasks, but they require a running task worker (`app.startWorker()` or `serve()`) to process them. **Serverless functions cannot run task workers** because they're short-lived.

**Solutions:**
- Use a separate long-running server or container for task processing
- Use platform-native queues: AWS SQS + Lambda triggers, Vercel Serverless Functions with queues
- Keep the task definitions in your app, but run `app.startWorker()` only in your worker deployment

### Cron Jobs

`app.cron()` registers jobs with CelsianJS's built-in scheduler, which ticks every second inside `serve()`. **Serverless functions don't run long enough for cron.**

**Solutions:**
- Use platform-native cron: Vercel Cron Jobs, AWS EventBridge, Cloudflare Cron Triggers
- Map your `app.cron()` schedules to platform cron config
- CelsianJS will warn at runtime if cron jobs are registered but the scheduler isn't started

### Route Tagging for Split Deployment

Use route tags to plan which routes go where:

```typescript
// Stateless API routes — deploy as serverless functions
app.route({ method: 'GET', url: '/api/users', kind: 'serverless', handler: listUsers });

// WebSocket or SSE — needs a persistent server
app.route({ method: 'GET', url: '/ws', kind: 'hot', handler: wsHandler });

// Background work — runs on worker processes
app.route({ method: 'POST', url: '/tasks/email', kind: 'task', handler: emailHandler });

const manifest = app.getRouteManifest();
// { serverless: [...], hot: [...], task: [...] }
```

## Deploy CLI

The `celsian deploy` command generates platform-specific deployment files:

```bash
# Generate Vercel deployment files
celsian deploy --target vercel

# Generate AWS Lambda (SAM) files
celsian deploy --target lambda

# Generate Cloudflare Workers files
celsian deploy --target cloudflare

# Generate Fly.io deployment files
celsian deploy --target fly

# Generate Railway deployment files
celsian deploy --target railway

# Generate Docker files only
celsian deploy --target docker
```

The command creates entry points and config files but does NOT deploy. After generation, use the platform's native CLI to deploy:

| Target | Files Generated | Deploy Command |
|--------|----------------|---------------|
| vercel | `api/index.ts`, `vercel.json` | `vercel deploy` |
| lambda | `lambda.ts`, `template.yaml` | `sam build && sam deploy` |
| cloudflare | `worker.ts`, `wrangler.toml` | `npx wrangler deploy` |
| fly | `Dockerfile`, `fly.toml` | `flyctl deploy` |
| railway | `Dockerfile`, `railway.json`, `Procfile` | `git push` or `railway up` |
| docker | `Dockerfile`, `.dockerignore` | `docker build && docker run` |

Existing files are never overwritten. Run the command again safely to see what's missing.

## Graceful Shutdown

All long-running deployments (Node.js, Bun, Deno, Fly.io, Railway) should use graceful shutdown:

```typescript
serve(app, {
  shutdownTimeout: 15_000,
  async onShutdown() {
    await db.close();
    await redis.quit();
    await queue.drain();
  },
});
```

On SIGTERM or SIGINT:

1. Stop accepting new connections
2. Wait for in-flight requests to complete (up to `shutdownTimeout`)
3. Stop the task worker
4. Stop the cron scheduler
5. Run your `onShutdown` hook

## Health Checks

Every deployment target supports health checks. Register them with `app.health()`:

```typescript
app.health({
  path: '/health',       // Liveness probe
  readyPath: '/ready',   // Readiness probe (checks plugin loading)
  check: async () => {
    return await db.isHealthy();
  },
});
```

- `/health` returns `{ "status": "ok" }` (or `503` if the check fails)
- `/ready` returns `{ "status": "ready" }` (or `503` if plugins are still loading)

## Route Tagging

Tag routes for deployment tooling. This is useful when splitting an app across serverless functions and long-running servers:

```typescript
// Stateless API routes -- deploy as serverless functions
app.route({ method: 'GET', url: '/api/users', kind: 'serverless', handler: listUsers });

// WebSocket or SSE -- needs a persistent server
app.route({ method: 'GET', url: '/ws', kind: 'hot', handler: wsHandler });

// Background work -- runs on worker processes
app.route({ method: 'POST', url: '/tasks/email', kind: 'task', handler: emailHandler });

// Export manifest for build tooling
const manifest = app.getRouteManifest();
// { serverless: [...], hot: [...], task: [...] }
```

## Static Files

For Node.js deployments, `serve()` can serve static files:

```typescript
serve(app, {
  port: 3000,
  staticDir: './public',  // Serves files from ./public with immutable cache headers
});
```

For edge deployments (Workers, Vercel Edge), serve static assets via the platform's built-in mechanisms (Cloudflare Sites, Vercel static).
