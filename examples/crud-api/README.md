# CelsianJS, CRUD API

A complete CRUD resource (todos) with filtering, search, sorting, pagination,
and hand-written validation that raises structured `HttpError`s.

## What it demonstrates

- All five verbs on one resource, including `PATCH` for partial updates
- Query-parameter filtering (`completed`, `priority`, `search`), sorting
  (`sort`, `order`), and pagination (`page`, `limit`)
- `HttpError` for 400 and 404 responses, so errors come back in the framework's
  structured shape
- An app factory (`createCrudApp()`) so tests build their own isolated instance
- CORS. Note `createApp()` sets NO security headers on its own: register the
  `security()` plugin if you want them (this example does not)

## Run it

Install once from the monorepo root (the example depends on workspace packages):

```bash
pnpm install
```

Then, from this directory:

```bash
pnpm dev            # tsx src/index.ts
pnpm test           # vitest, uses app.inject(), no server needed
celsian routes      # list routes without starting a server (needs @celsian/cli)
```

Server starts at http://localhost:3000. Override with `PORT`. Set
`CORS_ORIGIN` to change the allowed origin (default `http://localhost:3000`).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Liveness probe |
| GET | /ready | Readiness probe |
| GET | /todos | List, with filter/search/sort/pagination |
| POST | /todos | Create a todo |
| GET | /todos/:id | Get one todo |
| PUT | /todos/:id | Replace a todo |
| PATCH | /todos/:id | Update selected fields |
| DELETE | /todos/:id | Delete a todo (204) |

## Try it

```bash
curl -X POST http://localhost:3000/todos \
  -H 'Content-Type: application/json' \
  -d '{"title":"Buy groceries","priority":"high"}'

curl 'http://localhost:3000/todos?priority=high&sort=title&order=asc&page=1&limit=10'

curl -X PATCH http://localhost:3000/todos/1 \
  -H 'Content-Type: application/json' \
  -d '{"completed":true}'

curl -X DELETE http://localhost:3000/todos/1 -i

# 404, in the framework's structured error shape
curl http://localhost:3000/todos/999
```

## Not included

Todos live in an in-memory `Map` and are lost on restart. No auth: every
caller can read and write every todo.
