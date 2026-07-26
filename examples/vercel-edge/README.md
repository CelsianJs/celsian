# CelsianJS on Vercel, Edge Functions

Vercel Edge Functions are legacy. For new projects use
[`../vercel-serverless`](../vercel-serverless), which has full Node.js
compatibility and better cold-start behaviour. This example is kept for cases
where the edge runtime is specifically what you want, such as middleware-style
request interception.

## What it demonstrates

- `createVercelEdgeHandler()`, a direct Web `Request` to `Response` passthrough
- Deferring plugin registration without top-level `await`, which the edge
  runtime does not allow, by awaiting a stored promise inside the handler
- Producing Vercel Build Output API v3 artifacts from a plain esbuild script
- Reading the app's own route table at runtime via `app.getRoutes()`

## Layout

```
api/index.ts     the app plus the exported edge handler
build.mjs        bundles into .vercel/output/functions/api.func
vercel.json      build and install commands
```

`api/index.ts` also exports the app as `app`, so `celsian routes api/index.ts`
can list routes without deploying.

## Run it

Install once from the monorepo root (the example depends on workspace packages):

```bash
pnpm install
```

Then, from this directory:

```bash
pnpm build                        # writes .vercel/output/
celsian routes api/index.ts       # list routes without deploying (needs @celsian/cli)
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Status, runtime, timestamp |
| GET | /api/hello/:name | Greets the name in the path |
| POST | /api/echo | Echoes the parsed JSON body |
| GET | /api/routes | Lists the app's registered routes |

`build.mjs` writes routes that send every path to this one function, so paths
outside `/api` reach it too and fall through to the app's 404.

## Deploy

There is no deploy script here. `vercel.json` sets the build and install
commands, so deploying is `vercel deploy` (or `vercel deploy --prod`) from this
directory with the Vercel CLI.

## Not included

No database and no auth. Node built-ins are excluded from the bundle, so
anything that reaches for `node:*` will fail at the edge.
