# create-celsian

Scaffold a new [CelsianJS](https://github.com/CelsianJs/celsian) project. No install needed, no external dependencies.

```bash
npm create celsian@latest my-api
cd my-api
npm install
npm run dev
```

Equivalent forms:

```bash
npx create-celsian my-api
npx create-celsian my-api --template rest-api
npx @celsian/cli create my-api --template rest-api
```

## Usage

```
npx create-celsian <name> [--template <id>] [--force]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--template`, `-t <id>` | `full` | Which template to scaffold |
| `--force` | off | Scaffold into an existing non-empty directory |

`<name>` must be a valid npm package name: lowercase, no spaces, not starting with `.` or `_`. The project is created in `./<name>` and the name is substituted into `package.json` and the README.

## Templates

| Template | What you get |
|----------|--------------|
| `full` | Auth (JWT), user CRUD, RPC, background tasks, cron, OpenAPI/Swagger, CSRF + CORS + rate limiting, Docker, tests |
| `basic` | One app file with a health route and a params route |
| `rest-api` | REST CRUD with TypeBox request validation |
| `rpc-api` | `@celsian/rpc` procedures under `/_rpc/*` with an exported `AppRouter` type |

Every template ships with:

- TypeScript, ESM, strict mode
- `.env` plus a dev script that loads it
- `npm test` (Vitest, driving the app through `app.inject()` with no open port)
- `npm run lint` (`tsc --noEmit`)
- `npm run build` / `npm start`

The `full` template additionally ships `.env.example`, a multi-stage `Dockerfile`, and a much longer README.

## Scripts in a scaffolded project

```bash
npm run dev     # tsx watch mode, loads .env
npm test        # Vitest
npm run lint    # tsc --noEmit
npm run build   # tsc -> dist/
npm start       # node dist/index.js, loads .env
```

## What the entry file looks like

Every template exports the app and only starts a server when the file is the process entry point, so tests, `celsian routes`, and serverless handlers can import it without binding a port:

```ts
import { pathToFileURL } from 'node:url';
import { createApp, serve } from 'celsian';

export const app = createApp();

app.get('/health', (_req, reply) => reply.json({ status: 'ok' }));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(app);
}
```

## Production notes for the `full` template

It refuses to boot with `NODE_ENV=production` when it is still insecure by default:

- `JWT_SECRET` left at a scaffold placeholder value.
- `TRUST_PROXY` unset, which would put every client in a single shared rate-limit bucket. Set `TRUST_PROXY=true` (and `TRUSTED_PROXY_HOPS` if more than one proxy sits in front of the app) so the limiter keys on the real client IP, or replace the `keyGenerator` in `src/plugins/security.ts`.

The dev-only `GET /auth/token` route is not registered in production either.

## Requirements

Node.js 20 or newer.

## License

MIT
