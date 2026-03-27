# Quick Start Guide

Get a CelsianJS API running from zero to deployed in under 10 minutes.

## Prerequisites

- Node.js 18+ (or Bun, or Deno)
- npm, pnpm, or yarn

## Scaffold a Project

```bash
npx create-celsian my-api
cd my-api
npm install
npm run dev
```

The scaffolder creates a project with routing, a health check, and a dev server with hot reload.

## Manual Setup

If you prefer to start from scratch:

```bash
mkdir my-api && cd my-api
npm init -y
npm install @celsian/core
```

Create `server.ts`:

```typescript
import { createApp, serve } from '@celsian/core';

const app = createApp({ logger: true });

// Health check
app.health();

// Routes
app.get('/hello', (req, reply) => {
  return reply.json({ message: 'Hello, World!' });
});

app.get('/users/:id', (req, reply) => {
  const { id } = req.params;
  return reply.json({ id, name: 'Alice' });
});

app.post('/users', async (req, reply) => {
  const body = req.parsedBody as { name: string; email: string };
  return reply.status(201).json({ id: '1', name: body.name, email: body.email });
});

serve(app, { port: 3000 });
```

Run it:

```bash
npx tsx server.ts
# Or with Bun:
bun run server.ts
```

Visit `http://localhost:3000/hello` to see the response.

## Add Schema Validation

Install a schema library (Zod, TypeBox, or Valibot -- any works):

```bash
npm install zod
```

```typescript
import { z } from 'zod';

app.route({
  method: 'POST',
  url: '/users',
  schema: {
    body: z.object({
      name: z.string().min(1),
      email: z.string().email(),
    }),
  },
  handler(req, reply) {
    const { name, email } = req.parsedBody as { name: string; email: string };
    return reply.status(201).json({ id: '1', name, email });
  },
});
```

POST invalid JSON and you get a 400 with structured validation errors automatically.

## Add CORS and Security Headers

```typescript
import { createApp, serve, cors, security } from '@celsian/core';

const app = createApp({ logger: true });

await app.register(security(), { encapsulate: false });
await app.register(cors({
  origin: 'http://localhost:5173',
  credentials: true,
}), { encapsulate: false });
```

## Add JWT Authentication

```bash
npm install @celsian/jwt
```

```typescript
import { jwt, createJWTGuard } from '@celsian/jwt';

// Register the JWT plugin
await app.register(jwt({ secret: process.env.JWT_SECRET! }));

// Public route -- sign tokens
app.post('/login', async (req, reply) => {
  const body = req.parsedBody as { email: string; password: string };
  // ... validate credentials ...
  const token = await (app as any).jwt.sign(
    { sub: 'user-1', email: body.email },
    { expiresIn: '7d' }
  );
  return reply.json({ token });
});

// Protected routes -- use the guard as a preHandler hook
const requireAuth = createJWTGuard({ secret: process.env.JWT_SECRET! });

app.route({
  method: 'GET',
  url: '/me',
  preHandler: [requireAuth],
  handler(req, reply) {
    return reply.json({ user: (req as any).user });
  },
});
```

## Add a Background Task

```typescript
app.task({
  name: 'send-welcome-email',
  handler: async (input: { email: string; name: string }, ctx) => {
    ctx.log.info('Sending welcome email', { email: input.email });
    // ... send the email
  },
  retries: 3,
  timeout: 30_000,
});

// Enqueue from a handler
app.post('/users', async (req, reply) => {
  const body = req.parsedBody as { name: string; email: string };
  const user = { id: '1', ...body };

  await app.enqueue('send-welcome-email', { email: body.email, name: body.name });

  return reply.status(201).json(user);
});
```

The task worker starts automatically with `serve()`. For production, swap the in-memory queue for Redis:

```bash
npm install @celsian/queue-redis
```

```typescript
import { RedisQueue } from '@celsian/queue-redis';
app.queue = new RedisQueue({ url: process.env.REDIS_URL! });
```

## Add a Cron Job

```typescript
app.cron('daily-cleanup', '0 3 * * *', async () => {
  // Runs every day at 3:00 AM
  console.log('Running daily cleanup...');
});
```

## Write Tests

CelsianJS has built-in test injection -- no real HTTP server needed:

```typescript
import { describe, it, expect } from 'vitest';
import { createApp } from '@celsian/core';

describe('API', () => {
  it('returns hello', async () => {
    const app = createApp();
    app.get('/hello', (req, reply) => reply.json({ message: 'Hello' }));

    const response = await app.inject({ method: 'GET', url: '/hello' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe('Hello');
  });

  it('validates input', async () => {
    const app = createApp();
    app.route({
      method: 'POST',
      url: '/users',
      schema: { body: z.object({ name: z.string() }) },
      handler(req, reply) {
        return reply.status(201).json(req.parsedBody);
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { name: 123 },  // Wrong type
    });

    expect(response.status).toBe(400);
  });
});
```

## Deploy

See the [Deployment Guide](deployment.md) for detailed instructions on deploying to Node.js, Bun, Deno, Cloudflare Workers, AWS Lambda, Vercel, Fly.io, and Railway.

The shortest path to production:

```bash
# Fly.io
npm install @celsian/adapter-fly
flyctl launch
flyctl deploy

# Railway
git push  # Railway auto-detects Node.js
```

## Full Stack with WhatFW

Use CelsianJS as the API backend for a [WhatFW](https://whatfw.com) frontend:

```bash
# Backend
npx create-celsian my-api
cd my-api && npm run dev  # localhost:3000

# Frontend (in another terminal)
npm create what@latest my-app
cd my-app && npm run dev  # localhost:5173
```

Configure CORS in your CelsianJS app to accept requests from the frontend dev server:

```typescript
await app.register(cors({
  origin: 'http://localhost:5173',
  credentials: true,
}), { encapsulate: false });
```

CelsianJS and WhatFW are both part of the [WhatStack](https://whatfw.com) ecosystem -- the agent-first full stack.

## Next Steps

- [Hooks Lifecycle](hooks.md) -- Understanding the 8-hook request lifecycle
- [Plugins and Encapsulation](plugins.md) -- Writing reusable, scoped plugins
- [Database Plugin](database.md) -- Connection pools, transactions, analytics
