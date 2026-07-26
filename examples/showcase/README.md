# Pulse, the CelsianJS showcase

A real-time task board API that exercises most of CelsianJS in one app. This is
the widest example in the repo: if you want to see how the pieces fit together,
start here.

## What it demonstrates

- **REST API** with filtering, sorting, and cache invalidation
- **Type-safe RPC** (Zod-validated procedures) mounted alongside the REST routes
- **Server-sent events** for a live feed of task changes
- **Response caching** backed by an in-memory KV store
- **Cookie sessions** for register/login
- **Background tasks** with retries (`app.task` + `app.enqueue`)
- **Cron jobs** on a 5-field unix schedule (`app.cron`)
- **CORS** and structured request logging

## Run it

Install once from the monorepo root (the example depends on workspace packages):

```bash
pnpm install
```

Then, from this directory:

```bash
pnpm dev            # reload on change
pnpm start          # run once
pnpm test           # smoke test, no server needed
celsian routes      # list routes without starting a server (needs @celsian/cli)
```

Server starts at http://localhost:4000. Override with `PORT`.

`PASSWORD_SALT` falls back to an obvious placeholder so the demo runs with no
setup. Set a real one before building anything on top of it:

```bash
PASSWORD_SALT=$(node -e "console.log(crypto.randomBytes(32).toString('hex'))") pnpm start
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Liveness probe |
| GET | /ready | Readiness probe (waits for plugins) |
| POST | /api/auth/register | Create account |
| POST | /api/auth/login | Login, get a session cookie |
| GET | /api/me | Current user (session) |
| GET | /api/tasks | List tasks (query: status, priority, sort) |
| GET | /api/tasks/:id | Get a single task |
| POST | /api/tasks | Create a task |
| PUT | /api/tasks/:id | Update a task |
| DELETE | /api/tasks/:id | Delete a task |
| GET | /api/events | SSE live updates |

RPC procedures are mounted at `/rpc`. Paths are dot-separated, and queries
accept their input as a JSON-encoded `input` query parameter:

| Method | Path | Description |
|--------|------|-------------|
| GET | /rpc/tasks.list | List tasks |
| POST | /rpc/tasks.create | Create a task |
| POST | /rpc/tasks.complete | Mark a task done |
| GET | /rpc/tasks.stats | Task counts by status |
| GET | /rpc/system.health | Uptime and heap usage |
| GET | /rpc/manifest.json | Procedure manifest |
| GET | /rpc/openapi.json | OpenAPI document for the RPC router |

## Try it

```bash
# Register
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","name":"Ada","password":"secret123"}'

# Create a task
curl -X POST http://localhost:4000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Build the future","priority":"high"}'

# List tasks
curl http://localhost:4000/api/tasks

# Same thing over RPC
curl http://localhost:4000/rpc/tasks.stats

# Watch live updates (in another terminal)
curl -N http://localhost:4000/api/events
```

## Not included

There is no frontend and no persistence: everything lives in in-memory `Map`s
and is lost on restart. The password hashing here is a plain SHA-256 with a
salt, which is fine for a demo and not fine for real accounts (use argon2 or
bcrypt).
