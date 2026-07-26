# @celsian/cli

Command-line tools for [CelsianJS](https://github.com/CelsianJs/celsian) projects: dev server, route listing, bundling, scaffolding, code generation, and deployment config.

## Install

```bash
npm install -D @celsian/cli
```

Then run it with `npx celsian <command>`, or without installing anything:

```bash
npx @celsian/cli --help
```

## Commands

| Command | What it does |
|---------|--------------|
| `celsian dev` | Run your app with tsx, reload on file changes, load `.env` |
| `celsian create <name>` | Scaffold a new project |
| `celsian routes` | Print every route your app registered |
| `celsian build` | Bundle the app for production with esbuild |
| `celsian generate <route\|rpc> <name>` | Write a starter route or RPC procedure file |
| `celsian deploy` | Generate platform config and a handler that imports your app |

Global flags: `--version` / `-v`, `--help`.

---

### `celsian dev`

Starts your entry file under [tsx](https://tsx.is) and restarts it when any `.ts`/`.js` file under `src/` changes.

| Flag | Default | Description |
|------|---------|-------------|
| `--entry`, `-e <path>` | `src/index.ts` | Entry file |
| `--port`, `-p <port>` | (unset) | Exported to the child as `PORT` |
| `--host`, `-h <host>` | (unset) | Exported to the child as `HOST` |
| `--env-file <path>` | `.env` | Env file to load |

`.env` is loaded automatically when it exists (via Node's `--env-file`), so `celsian dev` matches the `npm run dev` script in the scaffolded templates. **Real environment variables win over the file** and are never overwritten. If `.env` is absent, the command runs without it rather than failing. Passing `--env-file` explicitly makes the file required.

```bash
npx celsian dev
npx celsian dev --port 8080 --entry src/server.ts
npx celsian dev --env-file .env.local
```

### `celsian create <name>`

Scaffolds a project into `./<name>`. Same generator as [`create-celsian`](https://www.npmjs.com/package/create-celsian).

| Flag | Default | Description |
|------|---------|-------------|
| `--template`, `-t <id>` | `full` | `full`, `basic`, `rest-api`, or `rpc-api` |
| `--force` | off | Allow scaffolding into a non-empty directory |

```bash
npx celsian create my-api --template rest-api
cd my-api && npm install && npm run dev
```

### `celsian routes`

Loads your entry file, finds the exported app (`export default app` or `export const app`), and prints its route table. Takes the entry as a positional argument (default `src/index.ts`).

```bash
npx celsian routes
npx celsian routes src/server.ts
```

```
  METHOD   URL          KIND
  ───────  ───────────  ──────────
  GET      /_rpc/*path  serverless
  POST     /_rpc/*path  serverless
  OPTIONS  /*path       serverless

  3 routes registered
```

Your entry is imported to do this, so guard any top-level `serve()` call behind an entry-point check (the scaffolded templates already do) or the command will boot your server just to read the table.

### `celsian build`

Bundles with esbuild. Install it first: `npm install -D esbuild`.

| Flag | Default | Description |
|------|---------|-------------|
| `--entry`, `-e <path>` | `src/index.ts` | Entry file |
| `--outdir`, `-o <path>` | `dist/` | Output directory |
| `--format`, `-f <fmt>` | `esm` | `esm`, `cjs`, or `iife` |
| `--target <target>` | `es2022` | esbuild target |
| `--platform <p>` | `node` | `node`, `browser`, or `neutral` |
| `--minify` | off | Minify output |
| `--verbose` | off | List each elided side-effect-only import |

```bash
npm install -D esbuild
npx celsian build --minify
```

```
ℹ Building src/index.ts
  format: esm  target: es2022  platform: node

✓ dist/index.js  462.1 KB

  Done in 46ms

  1 side-effect-only import elided (the package declares "sideEffects": false). This is expected -- run with --verbose for details.
```

Every Celsian package sets `"sideEffects": false`, so esbuild drops side-effect-only imports of them (for example `import '@celsian/jwt'` for its type augmentation). That is expected and is summarised as a count rather than printed as a warning per import.

### `celsian generate <type> <name>`

Aliased as `celsian g`. Writes a starter file into `src/routes/` (RPC procedure files live there too, matching the scaffold's `src/routes/rpc.ts`). Existing files are not overwritten.

```bash
npx celsian generate route products   # -> src/routes/products.ts
npx celsian g rpc billing             # -> src/routes/billing.ts
```

### `celsian deploy`

Generates the config files and the platform entrypoint for a target. The entrypoint **imports the app your entry file exports**, so what you deploy is your real app.

| Flag | Description |
|------|-------------|
| `--platform`, `-p <target>` | `vercel`, `lambda`, `cloudflare`, `fly`, `railway`, `docker` |
| `--deploy` | Also run the platform CLI (`vercel deploy`, `wrangler deploy`, ...) |

With no `--platform`, the target is inferred from an existing `wrangler.toml`, `fly.toml`, `vercel.json`, `railway.json`, or `template.yaml`. Existing files are never overwritten.

| Target | Files written |
|--------|---------------|
| `vercel` | `api/index.ts`, `vercel.json` |
| `lambda` | `lambda.ts`, `template.yaml` |
| `cloudflare` | `worker.ts`, `wrangler.toml` |
| `fly` | `Dockerfile`, `fly.toml`, `.dockerignore` |
| `railway` | `Dockerfile`, `railway.json`, `Procfile` |
| `docker` | `Dockerfile`, `.dockerignore` |

```bash
npx celsian deploy --platform vercel
```

```
ℹ Locating your app entry...
✓ Generated 2 file(s) for vercel:
  + api/index.ts
  + vercel.json

ℹ Install the platform adapter (required by the generated handler):
  npm install @celsian/adapter-vercel
```

The generated `api/index.ts`:

```ts
// Generated by: celsian deploy --platform vercel
// Imports the app exported from your entry file.

import { createVercelHandler } from "@celsian/adapter-vercel";
import { app } from "../src/index.js";

await app.ready();

export default createVercelHandler(app);
```

If your entry uses `export default app`, the generated import is a default import instead. The serverless targets also warn when your entry calls `serve()` at module scope, because the handler imports that file and would otherwise start a listening server on every cold start.

## Worked example

```bash
npx @celsian/cli create shop --template rest-api
cd shop
npm install

npx celsian routes          # inspect the route table
npm test                    # run the scaffolded Vitest suite
npx celsian dev --port 8080 # dev server on :8080, .env loaded

npm install -D esbuild
npx celsian build --minify  # bundle to dist/
npx celsian deploy --platform docker
```

## Notes

- Requires Node.js 20 or newer.
- `dev` and `routes` shell out to `npx tsx`, so `tsx` must be resolvable (the scaffolded templates include it as a devDependency).
- `build` requires `esbuild` as a devDependency in your project.

## License

MIT
