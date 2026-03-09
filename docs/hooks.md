# Hooks Lifecycle

CelsianJS provides 8 hooks that run in a defined order for every request. Hooks can short-circuit the request by returning a `Response`, or run side effects without altering the flow.

## Hook Order

```
Incoming Request
      |
      v
  onRequest -------> Auth checks, request logging, header injection
      |
  preParsing ------> Modify request before body is read
      |
  [Body Parsing] --- JSON, form-data, text (automatic)
      |
  preValidation ---> Transform data before schema validation
      |
  [Schema Validation]
      |
  preHandler ------> Business logic guards, data loading
      |
  [Route Handler]
      |
  preSerialization -> Transform response data before serialization
      |
  onSend ----------> Add/modify response headers (CORS, timing, etc.)
      |
  [Response Sent]
      |
  onResponse ------> Fire-and-forget: logging, metrics, cleanup
      |
  onError ---------- Catches any error thrown during the lifecycle
```

## Hook Reference

### onRequest

Runs immediately when a request is received, before body parsing. This is the earliest point to inspect or reject a request.

```typescript
app.addHook('onRequest', async (req, reply) => {
  // Add a request ID header
  reply.header('x-request-id', crypto.randomUUID());

  // Short-circuit: return a Response to stop the lifecycle
  if (req.headers.get('x-blocked') === 'true') {
    return reply.forbidden('Blocked');
  }
});
```

**Scope:** App-level and route-level.

```typescript
// Route-level onRequest
app.route({
  method: 'GET',
  url: '/admin',
  onRequest: [requireAdmin],
  handler(req, reply) {
    return reply.json({ admin: true });
  },
});
```

### preParsing

Runs after onRequest but before the request body is read and parsed. Use this to modify the raw request or skip body parsing for certain requests.

```typescript
app.addHook('preParsing', async (req, reply) => {
  // Log the content type before parsing
  console.log('Content-Type:', req.headers.get('content-type'));
});
```

**Scope:** App-level only.

### preValidation

Runs after body parsing but before schema validation. Use this to transform or augment the parsed body before it is validated.

```typescript
app.addHook('preValidation', async (req, reply) => {
  // Normalize email to lowercase before validation
  if (req.parsedBody && typeof req.parsedBody === 'object') {
    const body = req.parsedBody as Record<string, unknown>;
    if (typeof body.email === 'string') {
      body.email = body.email.toLowerCase();
    }
  }
});
```

**Scope:** App-level only.

### preHandler

Runs after validation, right before the route handler. This is the best place for authorization checks, data loading, or any guard that needs validated input.

```typescript
app.addHook('preHandler', async (req, reply) => {
  // Load user from database after JWT has been verified
  const userId = (req as any).user?.sub;
  if (userId) {
    const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    (req as any).userData = user;
  }
});
```

**Scope:** App-level and route-level.

```typescript
app.route({
  method: 'DELETE',
  url: '/users/:id',
  preHandler: [requireAdmin, loadUser],
  handler(req, reply) {
    return reply.status(204).send(null);
  },
});
```

### preSerialization

Runs after the handler returns but before the response body is serialized. Use this to transform response data.

```typescript
app.addHook('preSerialization', async (req, reply) => {
  // Add metadata to all responses
  // (Note: this hook runs but doesn't currently alter serialization)
});
```

**Scope:** App-level and route-level.

### onSend

Runs just before the response is sent to the client. This is the right place to modify response headers. Unlike other hooks, onSend does not short-circuit when `reply.sent` is true -- all registered onSend hooks always run.

```typescript
app.addHook('onSend', async (req, reply) => {
  // Add Server-Timing header
  reply.header('server-timing', `total;dur=${performance.now()}`);
});
```

This is how the CORS plugin works -- it adds `Access-Control-Allow-Origin` in an onSend hook.

**Scope:** App-level and route-level.

### onResponse

Runs after the response has been sent. This is fire-and-forget -- exceptions are silently ignored, and the hook does not block the response.

```typescript
app.addHook('onResponse', (req, reply) => {
  // Log response metrics (fire-and-forget)
  metrics.recordRequest(req.method, req.url, reply.statusCode);
});
```

**Scope:** App-level only.

### onError

Runs when any error is thrown during the request lifecycle. Multiple onError hooks can be registered; they run in order. Return a `Response` to handle the error, or return nothing to pass it to the next handler.

```typescript
app.addHook('onError', async (error, req, reply) => {
  // Log all errors
  console.error('Request error:', error.message);

  // Handle specific error types
  if (error.message.includes('UNIQUE constraint')) {
    return reply.conflict('Resource already exists');
  }

  // Return nothing to let the default error handler respond
});
```

**Scope:** App-level only.

## Short-Circuiting

Any hook (except onResponse and onError) can stop the request lifecycle by returning a `Response`:

```typescript
app.addHook('onRequest', async (req, reply) => {
  if (!req.headers.get('authorization')) {
    return reply.unauthorized('Missing token');
    // Lifecycle stops here. No parsing, validation, or handler runs.
  }
});
```

## Execution Order with Plugins

Hooks from encapsulated plugins only apply to routes registered within that plugin:

```typescript
async function adminPlugin(app) {
  // This hook only runs for routes inside this plugin
  app.addHook('onRequest', requireAdmin);

  app.get('/admin/dashboard', dashboardHandler);
  app.get('/admin/users', usersHandler);
}

// Public routes -- adminPlugin's onRequest does NOT run here
app.get('/health', healthHandler);

await app.register(adminPlugin, { prefix: '/api' });
```

Hooks from plugins registered with `{ encapsulate: false }` apply globally:

```typescript
await app.register(cors(), { encapsulate: false });
// CORS onSend hook now runs for ALL routes
```

## Common Patterns

### Request Timing

```typescript
app.addHook('onRequest', async (req, reply) => {
  (req as any).startTime = performance.now();
});

app.addHook('onSend', async (req, reply) => {
  const duration = performance.now() - (req as any).startTime;
  reply.header('x-response-time', `${Math.round(duration)}ms`);
});
```

### Authentication Guard

```typescript
function createAuthGuard(secret: string): HookHandler {
  return async (req, reply) => {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return reply.unauthorized();

    try {
      const payload = await verifyToken(token, secret);
      (req as any).user = payload;
    } catch {
      return reply.unauthorized('Invalid token');
    }
  };
}

app.route({
  method: 'GET',
  url: '/me',
  onRequest: [createAuthGuard(process.env.JWT_SECRET!)],
  handler(req, reply) {
    return reply.json({ user: (req as any).user });
  },
});
```

### Rate Limiting Per Route

```typescript
import { rateLimit } from '@celsian/rate-limit';

// Apply rate limiting only to auth routes
async function authRoutes(app) {
  await app.register(rateLimit({ max: 5, window: 60_000 }));

  app.post('/login', loginHandler);
  app.post('/register', registerHandler);
}

await app.register(authRoutes, { prefix: '/auth' });
```
