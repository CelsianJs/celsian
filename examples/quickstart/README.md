# CelsianJS, quickstart

A realistic starter: a todo API with JWT auth, split across route modules.
Copy this one when you are starting a project.

## What it demonstrates

- Splitting routes into modules and registering each as a plugin
  (`app.register(todoRoutes, { encapsulate: false })`)
- JWT auth with a shared guard (`preHandler: authGuard`) applied per route
- Zod body validation
- CORS, rate limiting, and the security headers `createApp()` enables by default
- Health and readiness probes
- Graceful shutdown via `serve()`'s `onShutdown`
- Testing with `app.inject()`, no server required

## Layout

```
src/
  index.ts              buildApp() plus the direct-run server bootstrap
  middleware/auth.ts    shared JWT secret, guard, and jwt instance
  routes/todos.ts       todo CRUD, registered as a plugin
  routes/auth.ts        register/login/me, registered as a plugin
test/api.test.ts        vitest suite over app.inject()
```

## Run it

Install once from the monorepo root (the example depends on workspace packages):

```bash
pnpm install
```

Then, from this directory:

```bash
pnpm dev            # tsx watch, reloads on change
pnpm test           # vitest
celsian routes      # list routes without starting a server (needs @celsian/cli)
```

Server starts at http://localhost:3000. Override with `PORT`. Set
`CORS_ORIGIN` to change the allowed origin.

`JWT_SECRET` falls back to an obvious placeholder so the example runs with no
setup. Generate a real secret before deploying anything based on this:

```bash
JWT_SECRET=$(node -e "console.log(crypto.randomBytes(32).toString('hex'))") pnpm dev
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | No | Liveness probe |
| GET | /ready | No | Readiness probe |
| GET | /todos | No | List todos |
| POST | /todos | No | Create a todo |
| GET | /todos/:id | No | Get one todo |
| PUT | /todos/:id | No | Update a todo |
| DELETE | /todos/:id | No | Delete a todo |
| POST | /auth/register | No | Create an account, get a JWT |
| POST | /auth/login | No | Exchange credentials for a JWT |
| GET | /auth/me | Bearer | The authenticated user's profile |

## Try it

```bash
curl -X POST http://localhost:3000/todos \
  -H 'Content-Type: application/json' \
  -d '{"title":"first todo"}'

curl http://localhost:3000/todos

TOKEN=$(curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"hunter2hunter2"}' | jq -r .token)

curl http://localhost:3000/auth/me -H "Authorization: Bearer $TOKEN"
```

## Not included

Todos and users live in memory and are lost on restart. The todo routes are
deliberately unauthenticated, so the auth routes can be shown in isolation:
in a real app you would put `authGuard` on them too.
