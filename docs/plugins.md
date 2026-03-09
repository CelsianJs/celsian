# Plugins and Encapsulation

CelsianJS uses a Fastify-inspired plugin system where each plugin runs in an isolated context. Hooks and decorations registered inside a plugin are scoped to that plugin's routes by default.

## Writing a Plugin

A plugin is a function that receives a `PluginContext` and an options object:

```typescript
import type { PluginFunction } from '@celsian/core';

const myPlugin: PluginFunction = async (app, options) => {
  // Register routes
  app.get('/status', (req, reply) => {
    return reply.json({ status: 'ok' });
  });

  // Add hooks (scoped to this plugin's routes)
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-plugin', 'active');
  });

  // Decorate the app instance
  app.decorate('myService', { doWork: () => 'done' });
};
```

Register it with the app:

```typescript
await app.register(myPlugin, { prefix: '/api' });
```

## Encapsulation

By default, plugins are **encapsulated**. This means:

- Hooks registered inside a plugin only run for routes defined in that plugin.
- Decorations registered inside a plugin are visible to the plugin and its children, but not to the parent or siblings.
- Route prefixes are scoped.

### Example: Scoped Auth

```typescript
async function publicRoutes(app) {
  app.get('/health', (req, reply) => reply.json({ status: 'ok' }));
  app.get('/docs', (req, reply) => reply.json({ version: '1.0' }));
}

async function protectedRoutes(app) {
  // This hook only applies to routes inside this plugin
  app.addHook('onRequest', async (req, reply) => {
    const token = req.headers.get('authorization');
    if (!token) return reply.unauthorized();
  });

  app.get('/me', (req, reply) => reply.json({ user: 'Alice' }));
  app.get('/settings', (req, reply) => reply.json({ theme: 'dark' }));
}

const app = createApp();

await app.register(publicRoutes);
// GET /health -- no auth required
// GET /docs -- no auth required

await app.register(protectedRoutes, { prefix: '/api' });
// GET /api/me -- auth required
// GET /api/settings -- auth required
```

The `onRequest` hook in `protectedRoutes` does not affect `publicRoutes`.

### Breaking Out of Encapsulation

Some plugins need to affect all routes globally. Pass `{ encapsulate: false }` to disable scoping:

```typescript
// CORS headers should apply to every route
await app.register(cors(), { encapsulate: false });

// Database should be accessible from all handlers
await app.register(database({ createPool: () => pool }), { encapsulate: false });

// Security headers everywhere
await app.register(security(), { encapsulate: false });
```

When `encapsulate: false` is set, hooks and decorations propagate to the parent scope and affect all routes.

## Nested Plugins

Plugins can register sub-plugins. Each level gets its own encapsulation scope:

```typescript
async function apiV1(app) {
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-api-version', '1');
  });

  await app.register(usersPlugin);
  await app.register(ordersPlugin);
}

async function apiV2(app) {
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-api-version', '2');
  });

  await app.register(usersPluginV2);
  await app.register(ordersPluginV2);
}

await app.register(apiV1, { prefix: '/api/v1' });
await app.register(apiV2, { prefix: '/api/v2' });
```

Routes under `/api/v1` get the `x-api-version: 1` header. Routes under `/api/v2` get `x-api-version: 2`. Neither leaks to the other.

## Decorators

Plugins can attach custom properties to the app, request, or reply objects.

### App Decorators

```typescript
async function dbPlugin(app) {
  const pool = await createPool();
  app.decorate('db', pool);
}

await app.register(dbPlugin, { encapsulate: false });

// Access later
const pool = app.getDecoration('db');
```

### Request Decorators

```typescript
async function userPlugin(app) {
  // Default value -- will be on every request
  app.decorateRequest('user', null);

  app.addHook('preHandler', async (req) => {
    const token = req.headers.get('authorization');
    if (token) {
      (req as any).user = await verifyToken(token);
    }
  });
}
```

### Reply Decorators

```typescript
app.decorateReply('sendCSV', function(data: string[][]) {
  // Custom reply method
});
```

## Plugin Options

Plugins receive options as their second argument:

```typescript
interface MyPluginOptions {
  prefix?: string;
  apiKey: string;
  timeout?: number;
}

const myPlugin: PluginFunction = async (app, options: MyPluginOptions) => {
  const timeout = options.timeout ?? 5000;

  app.get('/external', async (req, reply) => {
    const data = await fetchExternalAPI(options.apiKey, timeout);
    return reply.json(data);
  });
};

await app.register(myPlugin, {
  prefix: '/external',
  apiKey: process.env.API_KEY!,
  timeout: 10_000,
} as any);
```

## Built-In Plugins

CelsianJS ships with several plugins in `@celsian/core`:

### CORS

```typescript
import { cors } from '@celsian/core';

await app.register(cors({
  origin: ['https://myapp.com', 'https://staging.myapp.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
  maxAge: 86400,
}), { encapsulate: false });
```

The CORS plugin registers a catch-all `OPTIONS` route for preflight requests and adds CORS headers via an `onSend` hook.

### Security Headers

```typescript
import { security } from '@celsian/core';

await app.register(security({
  contentSecurityPolicy: "default-src 'self'",
  frameOptions: 'SAMEORIGIN',
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}), { encapsulate: false });
```

Sets X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Strict-Transport-Security, Referrer-Policy, and more.

### Database

See [Database Plugin](database.md) for full documentation.

### OpenAPI

```typescript
import { openapi } from '@celsian/core';

await app.register(openapi({
  title: 'My API',
  version: '1.0.0',
  description: 'REST API documentation',
  servers: [{ url: 'https://api.myapp.com' }],
}));
```

Serves an OpenAPI 3.1 JSON spec at `/docs/openapi.json` and a Swagger UI at `/docs`. Automatically extracts path parameters, query parameters, and request body schemas from your route definitions.

## Ecosystem Plugins

| Package | Registration |
| ------- | ------------ |
| `@celsian/jwt` | `app.register(jwt({ secret }))` |
| `@celsian/rate-limit` | `app.register(rateLimit({ max: 100, window: 60_000 }))` |
| `@celsian/compress` | `app.register(compress({ threshold: 1024 }))` |

## Pattern: Feature Plugin

A common pattern is to group routes, hooks, and services into a feature plugin:

```typescript
async function usersFeature(app) {
  // Scoped rate limit
  await app.register(rateLimit({ max: 50, window: 60_000 }));

  // Routes
  app.get('/users', listUsers);
  app.get('/users/:id', getUser);
  app.post('/users', createUser);
  app.put('/users/:id', updateUser);
  app.delete('/users/:id', deleteUser);
}

async function ordersFeature(app) {
  // Different rate limit
  await app.register(rateLimit({ max: 20, window: 60_000 }));

  app.get('/orders', listOrders);
  app.post('/orders', createOrder);
}

// Global plugins
await app.register(cors(), { encapsulate: false });
await app.register(security(), { encapsulate: false });

// Feature plugins
await app.register(usersFeature, { prefix: '/api' });
await app.register(ordersFeature, { prefix: '/api' });
```

Each feature has its own rate limit, but CORS and security headers apply everywhere.
