# CLAUDE.md -- AI-Assisted Development Guide for CelsianJS

## What is CelsianJS?

CelsianJS is a TypeScript-first web framework with no external runtime dependencies. It uses a hook-based lifecycle (inspired by Fastify), plugin encapsulation, and runs on Node.js, Cloudflare Workers, AWS Lambda, Vercel, Fly.io, and Railway.

## Repository Layout

```
packages/
  core/        -- Router, hooks, context, errors, logger, plugins (zero runtime deps)
  schema/      -- Schema validation adapters (Zod, TypeBox, Valibot) via StandardSchema
  rpc/         -- Type-safe RPC with client generation and OpenAPI output
  cli/         -- Dev server, build, scaffolding, route listing
  jwt/         -- JWT auth plugin (jose)
  cache/       -- Response cache, session store
  compress/    -- Gzip/Deflate compression middleware
  rate-limit/  -- Fixed-window rate limiter
  adapter-*/   -- Platform-specific HTTP adapters
  platform/    -- Deployment providers (stub implementations)
  queue-redis/ -- Redis-backed task queue
  edge-router/ -- CF Workers edge routing
  create-celsian/ -- Project scaffolding templates
```

## Key Architecture Decisions

- **No external runtime deps**: `@celsian/core` depends only on `@celsian/schema` (internal workspace package). No npm third-party runtime dependencies. Keep it that way.
- **ESM only**: All packages use `"type": "module"`. Use `.js` extensions in imports.
- **Plugin encapsulation**: Plugins register in an `EncapsulationContext`. Decorations and hooks are scoped.
- **Hook lifecycle**: `onRequest` -> `preHandler` -> handler -> `onSend` -> `onResponse`. Errors go to `onError`.
- **StandardSchema**: Schema validation uses a unified interface. Zod, TypeBox, and Valibot are adapted via `@celsian/schema`.
- **Structured errors**: Use `CelsianError`, `HttpError`, `ValidationError` -- never bare `throw new Error()` in library code.
- **Structured logging**: JSON logger (pino-style) with child loggers and request IDs.

## Commands

```bash
pnpm install          # Install all dependencies
pnpm build            # TypeScript build (tsc -b --force)
pnpm test             # Run all tests (vitest)
pnpm test:watch       # Watch mode
pnpm lint             # Biome linter
pnpm lint:fix         # Biome auto-fix
pnpm typecheck        # TypeScript type checking (tsc --noEmit)
pnpm bench            # Run benchmarks
```

## Testing

- **Framework**: Vitest with globals enabled
- **Test location**: `packages/*/test/*.test.ts`
- **HTTP testing**: Use `app.inject()` -- no real server needed
- **Pattern**: Create app, register routes/plugins, call `inject()`, assert on response

Example:
```ts
const app = createApp();
app.get('/hello', () => ({ message: 'world' }));
const res = await app.inject({ method: 'GET', url: '/hello' });
expect(res.statusCode).toBe(200);
```

## Conventions

- 2-space indent, no tabs
- Biome for linting and formatting (see `biome.json`)
- Conventional commit messages: `feat:`, `fix:`, `chore:`, `docs:`, `test:`
- Every source file starts with a comment: `// @celsian/<package> -- <description>`
- Errors in library code use `CelsianError`/`HttpError`, not bare `Error`
- Schema packages use `SchemaError`, platform packages use `PlatformError`
- `any` is warned by the linter -- prefer explicit types

## Important Files

- `packages/core/src/app.ts` -- Main CelsianApp class
- `packages/core/src/router.ts` -- Radix-tree router
- `packages/core/src/errors.ts` -- Error class hierarchy
- `packages/core/src/hooks.ts` -- Hook system
- `packages/core/src/context.ts` -- Plugin encapsulation context
- `packages/core/src/types.ts` -- Shared type definitions
- `packages/schema/src/detect.ts` -- Auto-detect schema library
- `packages/rpc/src/router.ts` -- RPC router

## Adding a New Package

1. Create `packages/<name>/` with `package.json`, `tsconfig.json`, `src/index.ts`
2. Add to `pnpm-workspace.yaml` (already uses `packages/*` glob)
3. Add to `tsconfig.json` references array
4. If it depends on core, use `@celsian/core` as a peer dependency
5. Add tests in `packages/<name>/test/`
6. Re-export from umbrella `packages/celsian/src/index.ts` if appropriate
