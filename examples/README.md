# CelsianJS examples

Every example is a workspace package. Install once from the monorepo root, then
work inside the example's directory:

```bash
pnpm install                 # from the repo root
cd examples/<name>
pnpm dev
```

Each example exports its app, so the CLI can list its routes without starting a
server. The CLI is not a dependency of the examples, so install it first:

```bash
npm install -g @celsian/cli

cd examples/<name>
celsian routes               # or: celsian routes <entry>
```

## Start here

| Example | What it shows | Run |
|---------|---------------|-----|
| [basic](./basic) | The smallest app: two routes and `serve()` | `pnpm dev` |
| [quickstart](./quickstart) | Realistic starter: modular routes, JWT auth, tests | `pnpm dev` |
| [showcase](./showcase) | The widest example: REST, RPC, SSE, cache, sessions, tasks, cron | `pnpm dev` |

## By feature

| Example | What it shows | Run |
|---------|---------------|-----|
| [rest-api](./rest-api) | Schema validation with TypeBox | `pnpm dev` |
| [crud-api](./crud-api) | Full CRUD with filtering, sorting, pagination, `HttpError` | `pnpm dev` |
| [rpc-api](./rpc-api) | Type-safe RPC with `@celsian/rpc` | `pnpm dev` |
| [auth-flow](./auth-flow) | JWT access tokens, refresh-token rotation, rate limiting | `pnpm dev` |
| [saas-demo](./saas-demo) | A SaaS backend in one file: auth, CRUD, tasks, cron, SSE, OpenAPI | `pnpm start` |

## By platform

| Example | Target | Run |
|---------|--------|-----|
| [docker](./docker) | A container image, built with esbuild | `pnpm compose:up` |
| [aws-lambda](./aws-lambda) | AWS Lambda behind API Gateway v2, deployed with SAM | `pnpm build && pnpm invoke` |
| [cloudflare-worker](./cloudflare-worker) | Cloudflare Workers with KV | `pnpm dev` |
| [vercel-serverless](./vercel-serverless) | Vercel Serverless Functions, plus a cron endpoint | `pnpm dev` |
| [vercel-edge](./vercel-edge) | Vercel Edge Functions (legacy, prefer vercel-serverless) | `pnpm build` |

## Conventions

- **Secrets.** Where an example needs a secret it falls back to an obvious
  `change-me` placeholder so it runs with no setup. Those placeholders are at
  least 32 bytes, so `@celsian/jwt` does not warn on boot, but they are not
  secrets. Generate a real one with
  `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`.
- **Ports.** Node examples listen on 3000 (the showcase on 4000) and respect
  `PORT`.
- **State.** Every example stores data in memory. Nothing survives a restart,
  and no example talks to a database.
- **Entry points.** Node examples start a server only when their entry file is
  run directly, so importing them (from a test, or from `celsian routes`) does
  not open a port.
