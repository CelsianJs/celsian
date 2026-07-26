# CelsianJS, auth flow

Register, login, refresh, logout, and a protected route. Access tokens are
JWTs; refresh tokens are opaque, stored server-side, and rotated on use.

## What it demonstrates

- `@celsian/jwt`: registering the plugin, signing tokens, and guarding routes
  with `createJWTGuard()`
- Refresh-token rotation (the old token is deleted when a new one is issued)
- Password hashing with Node's built-in `scrypt` plus `timingSafeEqual`
- `@celsian/rate-limit` on the whole app
- Zod body validation and structured `HttpError` responses

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

Server starts at http://localhost:3000. Override with `PORT`.

`JWT_SECRET` falls back to an obvious placeholder so the example runs with no
setup, and the process refuses to start with that placeholder when
`NODE_ENV=production`. Generate a real secret with:

```bash
JWT_SECRET=$(node -e "console.log(crypto.randomBytes(32).toString('hex'))") pnpm dev
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | No | Liveness probe |
| GET | /ready | No | Readiness probe |
| POST | /auth/register | No | Create an account, get both tokens |
| POST | /auth/login | No | Exchange credentials for both tokens |
| POST | /auth/refresh | No | Rotate a refresh token, get a new access token |
| POST | /auth/logout | No | Invalidate a refresh token |
| GET | /auth/me | Bearer | The authenticated user's profile |

## Try it

```bash
# Register (passwords must be at least 8 characters)
curl -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"hunter2hunter2"}'

# Login and keep the access token
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"hunter2hunter2"}' | jq -r .accessToken)

curl http://localhost:3000/auth/me -H "Authorization: Bearer $TOKEN"

# Without a token, 401
curl -i http://localhost:3000/auth/me
```

## Not included

Users and refresh tokens live in in-memory `Map`s and are lost on restart.
Access tokens expire after 15 minutes and cannot be revoked before then, which
is the usual trade-off for stateless JWTs.
