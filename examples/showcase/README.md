# Pulse — CelsianJS Showcase

A real-time task board API demonstrating every CelsianJS feature.

## Features

- **REST API** — Full CRUD with filtering, sorting, pagination
- **Authentication** — Register/login with sessions
- **Type-Safe RPC** — Zod-validated procedures
- **Real-Time** — SSE live feed for task updates
- **Caching** — Response cache with automatic invalidation
- **Sessions** — Cookie-based session management
- **Task Queue** — Background notifications with retry
- **Cron Jobs** — Scheduled cleanup of completed tasks
- **Middleware** — CORS, rate limiting, structured logging

## Quick Start

```bash
pnpm install
pnpm dev
```

Server starts at http://localhost:4000

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Server health + stats |
| POST | /api/auth/register | Create account |
| POST | /api/auth/login | Login, get session |
| GET | /api/me | Current user (session) |
| GET | /api/tasks | List tasks (filter: status, priority, sort) |
| GET | /api/tasks/:id | Get single task |
| POST | /api/tasks | Create task |
| PUT | /api/tasks/:id | Update task |
| DELETE | /api/tasks/:id | Delete task |
| GET | /api/events | SSE live updates |
| GET | /api/queue | Task queue stats |
| POST | /rpc/tasks/create | RPC: create task |
| GET | /rpc/tasks/list | RPC: list tasks |
| GET | /rpc/tasks/stats | RPC: task statistics |
| GET | /rpc/system/health | RPC: system info |

## Try It

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

# Watch live updates (in another terminal)
curl -N http://localhost:4000/api/events
```
