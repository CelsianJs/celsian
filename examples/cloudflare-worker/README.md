# CelsianJS — Cloudflare Workers Example

Deploys a CelsianJS app to Cloudflare Workers with KV storage, CORS, and security headers.

## Routes

| Method   | Path           | Description                        |
|----------|----------------|------------------------------------|
| `GET`    | `/health`      | Health check                       |
| `GET`    | `/api/info`    | Environment and region info (JSON) |
| `GET`    | `/kv/:key`     | Read a value from KV               |
| `PUT`    | `/kv/:key`     | Write a value to KV                |
| `DELETE` | `/kv/:key`     | Delete a value from KV             |

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A Cloudflare account (`wrangler login`)

## Setup

1. Install dependencies from the monorepo root:

```bash
pnpm install
```

2. Create the KV namespace:

```bash
cd examples/cloudflare-worker
wrangler kv namespace create CACHE
wrangler kv namespace create CACHE --preview
```

3. Copy the namespace IDs from the output into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "<paste id here>"
preview_id = "<paste preview_id here>"
```

## Development

```bash
pnpm dev
```

This starts a local dev server via Wrangler at `http://localhost:8787`.

Test the endpoints:

```bash
# Health check
curl http://localhost:8787/health

# Environment info
curl http://localhost:8787/api/info

# Write to KV
curl -X PUT http://localhost:8787/kv/greeting \
  -H 'Content-Type: application/json' \
  -d '{"value": "hello world", "ttl": 3600}'

# Read from KV
curl http://localhost:8787/kv/greeting

# Delete from KV
curl -X DELETE http://localhost:8787/kv/greeting
```

## Build

Bundle the Worker into a single file:

```bash
pnpm build
```

Output: `dist/index.js`

## Deploy

Build and deploy in one step:

```bash
pnpm deploy
```

Or deploy separately:

```bash
pnpm build
wrangler deploy
```

## Monitoring

Tail live logs from production:

```bash
pnpm tail
```

## Project Structure

```
examples/cloudflare-worker/
  src/index.ts       Worker entry point
  build.mjs          esbuild bundler script
  wrangler.toml      Cloudflare Workers config
  package.json       Dependencies
  tsconfig.json      TypeScript config
```
