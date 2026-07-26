# CelsianJS, REST API with schema validation

A small users API that validates request bodies with TypeBox.

## What it demonstrates

- Route-level `schema.body` validation
- `req.parsedBody`, typed from the schema
- TypeBox as the schema library (Zod and Valibot work the same way, via
  `@celsian/schema`)
- 201 / 404 responses with `reply.status()`

## Run it

Install once from the monorepo root (the example depends on workspace packages):

```bash
pnpm install
```

Then, from this directory:

```bash
pnpm dev            # tsx src/index.ts
celsian routes      # list routes without starting a server (needs @celsian/cli)
```

Server starts at http://localhost:3000. Override with `PORT`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /users | List all users |
| POST | /users | Create a user (validated) |
| GET | /users/:id | Get one user, 404 if missing |

## Try it

```bash
curl -X POST http://localhost:3000/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com"}'

curl http://localhost:3000/users
curl http://localhost:3000/users/1

# Fails validation, returns 400 with the offending field
curl -X POST http://localhost:3000/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Bad","email":"nope"}'
```

## A note on TypeBox formats

The email field uses a `pattern`, not `format: "email"`. TypeBox format
keywords are opt-in: unless you register them with TypeBox's `FormatRegistry`,
validation fails with `Unknown format 'email'`.

## Not included

Users live in an in-memory array and are lost on restart. No auth.
