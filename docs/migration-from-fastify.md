# Migrating from Fastify to CelsianJS

This guide shows side-by-side comparisons for developers coming from Fastify. CelsianJS shares many of Fastify's design principles (hook lifecycle, plugin encapsulation, inject-based testing) but differs in key areas: TypeScript-first with zero runtime deps, StandardSchema validation, and multi-runtime support.

## Creating an App

**Fastify:**

```typescript
import Fastify from "fastify";

const app = Fastify({ logger: true });
```

**Celsian:**

```typescript
import { createApp } from "@celsian/core";

const app = createApp({ logger: true });
```

## Route Definition

Both frameworks use the same verb methods. Celsian handlers receive `(request, reply)` and can return a value directly (auto-serialized to JSON).

**Fastify:**

```typescript
app.get("/users/:id", async (request, reply) => {
  const { id } = request.params;
  const user = await db.findUser(id);
  if (!user) {
    reply.code(404).send({ error: "Not found" });
    return;
  }
  return user;
});
```

**Celsian:**

```typescript
app.get("/users/:id", async (req, reply) => {
  const { id } = req.params;
  const user = await db.findUser(id);
  if (!user) {
    return reply.notFound("User not found");
  }
  return user; // auto-serialized to JSON
});
```

Key differences:
- Celsian's `request.params` is typed based on the route path (e.g., `"/users/:id"` infers `{ id: string }`).
- Celsian provides convenience error methods on reply: `notFound()`, `badRequest()`, `unauthorized()`, `forbidden()`, `conflict()`, etc.

## Plugin Registration

Both frameworks use `register()` with encapsulation. The API is nearly identical.

**Fastify:**

```typescript
async function myPlugin(fastify, opts) {
  fastify.get("/hello", async () => ({ hello: opts.greeting }));
}

app.register(myPlugin, { greeting: "world" });
```

**Celsian:**

```typescript
async function myPlugin(app, opts) {
  app.get("/hello", () => ({ hello: opts.greeting }));
}

app.register(myPlugin, { greeting: "world" });
```

Prefix-based encapsulation works the same way:

```typescript
// Both frameworks
app.register(apiRoutes, { prefix: "/api/v1" });
```

## Decorating Request/Reply

**Fastify:**

```typescript
fastify.decorateRequest("user", null);
fastify.decorateReply("sendSuccess", function (data) {
  this.send({ success: true, data });
});
```

**Celsian:**

```typescript
app.decorate("db", databasePool);
// Access via app.db or through plugin context
```

Celsian uses `decorate()` at the app level. Decorations are scoped by the encapsulation context they're registered in. Request-level data is typically set via hooks modifying `request` properties rather than through separate decoration APIs.

## Hook Lifecycle

Both frameworks use a hook-based lifecycle. The mapping:

| Fastify Hook      | Celsian Hook   | Purpose                                    |
|-------------------|----------------|--------------------------------------------|
| `onRequest`       | `onRequest`    | First hook after request received           |
| `preParsing`      | _(none)_       | Before body parsing                         |
| `preValidation`   | _(none)_       | Before schema validation                    |
| `preHandler`      | `preHandler`   | After validation, before handler            |
| `preSerialization`| _(none)_       | Before response serialization               |
| `onSend`          | `onSend`       | Before response is sent (can modify)        |
| `onResponse`      | `onResponse`   | After response sent (fire-and-forget)       |
| `onError`         | `onError`      | When an error occurs                        |

**Fastify:**

```typescript
fastify.addHook("onRequest", async (request, reply) => {
  request.startTime = Date.now();
});

fastify.addHook("onResponse", async (request, reply) => {
  console.log(`${request.method} ${request.url} took ${Date.now() - request.startTime}ms`);
});
```

**Celsian:**

```typescript
app.addHook("onRequest", (request, reply) => {
  request.startTime = Date.now();
});

app.addHook("onResponse", (request, reply) => {
  console.log(`${request.method} ${request.url} took ${Date.now() - request.startTime}ms`);
});
```

Hooks work nearly identically. In Celsian, returning a `Response` from `onRequest` or `preHandler` short-circuits the pipeline (same concept as Fastify's `reply.send()` in hooks).

## Schema Validation

This is a significant difference. Fastify uses JSON Schema with Ajv by default. Celsian uses StandardSchema, supporting Zod, TypeBox, and Valibot through a unified adapter.

**Fastify (JSON Schema + Ajv):**

```typescript
app.post("/users", {
  schema: {
    body: {
      type: "object",
      required: ["name", "email"],
      properties: {
        name: { type: "string" },
        email: { type: "string", format: "email" },
      },
    },
    response: {
      200: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
        },
      },
    },
  },
  handler: async (request) => {
    return createUser(request.body);
  },
});
```

**Celsian (Zod via StandardSchema):**

```typescript
import { z } from "zod";

app.post("/users", {
  schema: {
    body: z.object({
      name: z.string(),
      email: z.string().email(),
    }),
    response: z.object({
      id: z.number(),
      name: z.string(),
    }),
  },
}, async (req) => {
  return createUser(req.body); // body is typed as { name: string; email: string }
});
```

You can also use TypeBox (which produces JSON Schema under the hood, so it's familiar) or Valibot. Celsian auto-detects which library you're using.

> **Where Fastify wins:** Fastify's compiled JSON Schema serialization (via `fast-json-stringify`) is faster than Zod/Valibot for serialization-heavy workloads. If you're doing thousands of large JSON responses per second, Fastify's approach has a measurable edge.

## Error Handling

**Fastify:**

```typescript
fastify.setErrorHandler((error, request, reply) => {
  if (error.validation) {
    reply.status(422).send({ errors: error.validation });
    return;
  }
  reply.status(500).send({ error: "Something went wrong" });
});
```

**Celsian:**

```typescript
app.setErrorHandler((error, request, reply) => {
  if (error instanceof ValidationError) {
    return reply.json({ errors: error.issues }, 422);
  }
  return reply.internalServerError();
});
```

Celsian uses typed error classes (`HttpError`, `ValidationError`, `CelsianError`) with built-in JSON serialization. You can throw them from handlers and they auto-serialize:

```typescript
import { HttpError } from "@celsian/core";

app.get("/admin", (req) => {
  if (!req.user?.isAdmin) {
    throw new HttpError(403, "Admin access required");
  }
  // ...
});
```

## Testing with inject()

This is nearly identical between the two frameworks. If you're used to Fastify's `inject()`, you'll feel right at home.

**Fastify:**

```typescript
const response = await app.inject({
  method: "GET",
  url: "/users/1",
  headers: { authorization: "Bearer token123" },
});

expect(response.statusCode).toBe(200);
expect(response.json()).toEqual({ id: 1, name: "Alice" });
```

**Celsian:**

```typescript
const response = await app.inject({
  method: "GET",
  url: "/users/1",
  headers: { authorization: "Bearer token123" },
});

expect(response.statusCode).toBe(200);
expect(response.json()).toEqual({ id: 1, name: "Alice" });
```

Both use a fake HTTP injection approach -- no real server needed for unit tests.

## JWT Authentication

**Fastify (with @fastify/jwt):**

```typescript
import fastifyJwt from "@fastify/jwt";

app.register(fastifyJwt, { secret: "supersecret" });

app.decorate("authenticate", async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch {
    reply.send(err);
  }
});

app.get("/protected", { preValidation: [app.authenticate] }, async (request) => {
  return { user: request.user };
});
```

**Celsian (with @celsian/jwt):**

```typescript
import { jwt, createJWTGuard } from "@celsian/jwt";

app.register(jwt({ secret: "supersecret" }));

const guard = createJWTGuard();

app.get("/protected", { preHandler: [guard] }, async (req) => {
  return { user: req.user }; // typed via declaration merging
});
```

Both use plugin registration with a guard hook. Celsian's `createJWTGuard()` auto-detects the registered JWT plugin. TypeScript knows about `req.user` and `app.jwt` through declaration merging.

## Deployment

This is a major difference.

**Fastify:** Node.js only. Requires `fastify.listen()`.

```typescript
await fastify.listen({ port: 3000 });
```

**Celsian:** Multi-runtime. `serve()` auto-detects Node.js, Bun, and Deno. For serverless, use adapters.

```typescript
// Node.js / Bun / Deno (auto-detected)
import { serve } from "@celsian/core";
await serve(app, { port: 3000 });

// Cloudflare Workers
export default { fetch: app.fetch };

// AWS Lambda
import { lambdaHandler } from "@celsian/adapter-lambda";
export const handler = lambdaHandler(app);

// Vercel Edge
import { vercelHandler } from "@celsian/adapter-vercel";
export default vercelHandler(app);
```

Celsian is built on Web Standard APIs (`Request`/`Response`), so `app.fetch` works anywhere the Fetch API is available.

## What Fastify Does Better

Being honest about trade-offs:

- **Ecosystem maturity:** Fastify has hundreds of community plugins. Celsian's ecosystem is young.
- **JSON Schema serialization:** Fastify's `fast-json-stringify` compiles response schemas into optimized serializers. For high-throughput JSON APIs, this is measurably faster than runtime serialization.
- **Battle-tested at scale:** Fastify powers major production workloads. Celsian is newer.
- **Documentation:** Fastify has comprehensive docs covering edge cases. Celsian's docs are still growing.
- **HTTP/2 support:** Fastify supports HTTP/2 natively. Celsian currently targets HTTP/1.1 (reverse proxies handle HTTP/2 in production).

## What Celsian Adds

- **Zero runtime dependencies** in core -- no supply chain risk.
- **Multi-runtime:** Deploy the same app to Node.js, Bun, Deno, Cloudflare Workers, Lambda, Vercel.
- **StandardSchema validation:** Use Zod, TypeBox, or Valibot with full TypeScript inference. No JSON Schema boilerplate.
- **Built-in features:** Security headers, CORS, CSRF, SSE, WebSocket, task queues, cron -- all included without third-party plugins.
- **Web Standards:** Built on `Request`/`Response`, not Node.js streams. Future-proof API surface.

## Migration Checklist

1. Replace `import Fastify from "fastify"` with `import { createApp } from "@celsian/core"`
2. Replace `fastify.listen()` with `serve(app, { port })`
3. Replace JSON Schema definitions with Zod/TypeBox/Valibot schemas
4. Replace `@fastify/jwt` with `@celsian/jwt`
5. Replace `@fastify/cors` with `app.register(cors())`
6. Replace `@fastify/helmet` with `app.register(security())`
7. Replace `@fastify/rate-limit` with `@celsian/rate-limit`
8. Replace `reply.code(n).send(data)` with `reply.json(data, n)` or return data directly
9. Update error handling to use `HttpError` / `ValidationError`
10. Update test imports -- `inject()` API is the same

Most routes migrate with minimal changes. The biggest refactoring effort is usually schema validation (JSON Schema to Zod/TypeBox) and replacing Fastify-specific plugins with Celsian equivalents.
