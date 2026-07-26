# SaaS Backend in One File

A complete SaaS backend built with CelsianJS in a single file. Demonstrates:

- Health endpoint
- JWT authentication (login + register)
- Users CRUD with Zod validation
- Dashboard stats endpoint
- Background task: welcome email
- Cron job: daily report
- SSE endpoint for real-time events
- OpenAPI docs at /docs

## Run

Install once from the monorepo root (the example depends on workspace packages):

```bash
pnpm install
```

Then, from this directory:

```bash
pnpm start          # or: pnpm dev   for reload on change
```

Server starts on `http://localhost:3000`. Override with `PORT`.

`JWT_SECRET` falls back to an obvious placeholder so the demo runs with no
setup. Set a real one before deploying anything based on this:

```bash
JWT_SECRET=$(node -e "console.log(crypto.randomBytes(32).toString('hex'))") pnpm start
```

To list the routes without starting a server:

```bash
celsian routes      # needs @celsian/cli
```

## Endpoints

| Method | Path             | Auth | Description              |
|--------|------------------|------|--------------------------|
| GET    | /health          | No   | Health check             |
| GET    | /ready           | No   | Readiness check          |
| POST   | /register        | No   | Create account           |
| POST   | /login           | No   | Get JWT token            |
| GET    | /users           | Yes  | List all users           |
| GET    | /users/:id       | Yes  | Get user by ID           |
| PUT    | /users/:id       | Yes  | Update user              |
| DELETE | /users/:id       | Yes  | Delete user              |
| GET    | /dashboard/stats | Yes  | Dashboard statistics     |
| GET    | /events          | Yes  | SSE real-time events     |
| GET    | /docs            | No   | OpenAPI / Swagger UI     |

## Try It

```bash
# Register
curl -X POST http://localhost:3000/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"secret123","name":"Alice"}'

# Login
curl -X POST http://localhost:3000/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"secret123"}'

# Use the token from login response
TOKEN="<paste token here>"

# List users
curl http://localhost:3000/users -H "Authorization: Bearer $TOKEN"

# Dashboard
curl http://localhost:3000/dashboard/stats -H "Authorization: Bearer $TOKEN"

# SSE events
curl -N http://localhost:3000/events -H "Authorization: Bearer $TOKEN"
```
