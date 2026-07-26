# CelsianJS on Vercel, Serverless Functions

The recommended way to deploy CelsianJS on Vercel: the Node.js runtime, with
Fluid Compute for cold-start behaviour and full Node API access.

## What it demonstrates

- `createVercelHandler()`, which adapts Vercel's `(req, res)` Node signature to
  the app
- A catch-all rewrite in `vercel.json`, so one function serves every route
- A Vercel Cron Job endpoint guarded by `CRON_SECRET`, using
  `createVercelCronHandler()`
- Bridging a Web-standard handler into the Node runtime with core's
  `nodeToWebRequest()` and `writeWebResponse()`

## Layout

```
api/index.ts     the app, exported as a Vercel function
api/cron.ts      the scheduled endpoint
vercel.json      rewrites plus the cron schedule
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
pnpm dev                          # vercel dev (needs the Vercel CLI)
celsian routes api/index.ts       # list routes without deploying (needs @celsian/cli)
celsian routes api/cron.ts
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Status, runtime, timestamp |
| GET | /api/hello/:name | Greets the name in the path |
| POST | /api/echo | Echoes the parsed JSON body |
| GET | /api/routes | Lists the app's registered routes |
| GET | /api/cron | Scheduled task, requires `Authorization: Bearer $CRON_SECRET` |

## Cron

`vercel.json` schedules `/api/cron` hourly. The handler rejects every request
with 503 when `CRON_SECRET` is unset, and 401 when the bearer token does not
match, so set it in the project's environment variables:

```bash
vercel env add CRON_SECRET
```

## Deploy

```bash
pnpm deploy         # preview
pnpm deploy:prod    # production
```

## Not included

No database, no auth, no persistence: the routes are stateless demos. The cron
handler logs and returns; the real work is a TODO in `api/cron.ts`.
