# CelsianJS, basic

The smallest useful CelsianJS app: two routes and `serve()`. Start here if you
have never used the framework.

## What it demonstrates

- `createApp()` and `serve()` from the umbrella `celsian` package
- A static route and a route with a path parameter (`req.params.name`)
- `reply.json()`

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
| GET | /health | Status and current timestamp |
| GET | /hello/:name | Greets the name in the path |

## Try it

```bash
curl http://localhost:3000/health
curl http://localhost:3000/hello/Ada
```

## Not included

No validation, no auth, no persistence. See `../rest-api` for schema
validation and `../quickstart` for a realistic starter.
