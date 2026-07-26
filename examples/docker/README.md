# CelsianJS on Docker

Bundles a CelsianJS app into a single file with esbuild and ships it in a
multi-stage image that runs as a non-root user.

## What it demonstrates

- A two-stage build: compile the workspace packages and bundle in the builder
  stage, copy one `index.js` into a slim runtime stage
- `trustProxy: true`, for running behind a load balancer or ingress
- Binding `0.0.0.0` explicitly, so the port is reachable from outside the
  container
- A container `HEALTHCHECK` pointed at `app.health()`'s `/health`
- A compose file with an optional Redis service for queue-backed tasks

## Build context

The Dockerfile copies from the **monorepo root**, not from this directory, so
the whole pnpm workspace is available to `pnpm install --frozen-lockfile`.
Ignore rules live in `Dockerfile.dockerignore`: BuildKit reads
`<dockerfile>.dockerignore` before the context-root `.dockerignore`, and a
`.dockerignore` placed here would be ignored entirely.

## Run it

Locally, without Docker:

```bash
pnpm install        # from the monorepo root
pnpm dev            # tsx src/index.ts
celsian routes      # list routes without starting a server (needs @celsian/cli)
```

With Docker, from this directory:

```bash
pnpm docker:build   # docker build -f Dockerfile -t celsian-api ../..
pnpm docker:run     # docker run -p 3000:3000 celsian-api
```

Or with compose (which sets the context for you, and starts Redis alongside):

```bash
pnpm compose:up
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Liveness probe, used by HEALTHCHECK |
| GET | /ready | Readiness probe |
| GET | /hello/:name | Greets the name in the path |
| POST | /echo | Echoes the parsed JSON body |

## Try it

```bash
curl http://localhost:3000/health
curl http://localhost:3000/hello/Ada
curl -X POST http://localhost:3000/echo \
  -H 'Content-Type: application/json' \
  -d '{"a":1}'
```

## Not included

The Redis service in `docker-compose.yml` is started but nothing in this
example connects to it: it is there as a starting point for
`@celsian/queue-redis`. There is no reverse proxy, no TLS, and no persistence.
