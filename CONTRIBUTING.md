# Contributing to CelsianJS

Thank you for your interest in contributing to CelsianJS. This guide covers setup, coding standards, and the pull request process.

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+

### Setup

```bash
git clone https://github.com/CelsianJs/celsian.git
cd celsian
pnpm install
pnpm build
pnpm test
```

### Project Structure

CelsianJS is a monorepo managed with pnpm workspaces:

```
packages/
  core/           # Router, hooks, context, errors, logger, plugins
  schema/         # Schema validation adapters (Zod, TypeBox, Valibot)
  rpc/            # Type-safe RPC layer
  cli/            # CLI tooling (dev, build, create)
  jwt/            # JWT authentication plugin
  cache/          # Response and session caching
  compress/       # Compression middleware
  rate-limit/     # Rate limiting plugin
  adapter-node/   # Node.js HTTP adapter
  adapter-cloudflare/  # Cloudflare Workers adapter
  adapter-lambda/      # AWS Lambda adapter
  adapter-vercel/      # Vercel adapter
  adapter-fly/         # Fly.io adapter
  adapter-railway/     # Railway adapter
  platform/       # Deployment providers
  queue-redis/    # Redis-backed task queue
  edge-router/    # Edge routing layer
  create-celsian/ # Project scaffolding
```

## Coding Standards

- **TypeScript** for all source code
- **Biome** for linting and formatting: `pnpm lint` / `pnpm lint:fix`
- **2-space indentation**, no tabs
- **No external runtime dependencies** in `@celsian/core` (zero-dep core)
- Use `CelsianError` or `HttpError` instead of bare `throw new Error()` in library code
- Prefer explicit types over `any` where possible

## Testing

- **Vitest** for all tests
- Tests live in `packages/*/test/` directories
- Run all tests: `pnpm test`
- Run tests in watch mode: `pnpm test:watch`

### Test expectations

- All new features must include tests
- All bug fixes should include a regression test
- Tests should use the `inject()` helper for HTTP testing (no real server needed)
- Aim for meaningful coverage, not 100% line coverage

## Adding a Plugin

1. Create a new package: `packages/<plugin-name>/`
2. Add `package.json` with `@celsian/<plugin-name>` name and `@celsian/core` as a peer dependency
3. Export a plugin function: `export function myPlugin(options): PluginFunction`
4. Add tests in `packages/<plugin-name>/test/`
5. Re-export from the umbrella package `packages/celsian/src/index.ts` if appropriate

## Adding an Adapter

1. Create `packages/adapter-<platform>/`
2. Implement the platform-specific request/response conversion
3. Export a `serve()` or `handler()` function
4. Add at least one integration test
5. Document any platform-specific configuration

## Pull Request Process

1. Fork the repository and create a feature branch from `main`
2. Make your changes with clear, descriptive commits
3. Ensure `pnpm build && pnpm test && pnpm lint` all pass
4. Open a PR against `main` with:
   - A clear title describing the change
   - A description of what and why
   - Any breaking changes called out explicitly
5. Wait for CI to pass and a maintainer review

### Commit Messages

Use conventional-style messages:

- `feat: add WebSocket heartbeat support`
- `fix: correct cookie path matching`
- `chore: update dependencies`
- `docs: improve plugin authoring guide`
- `test: add rate-limit edge case coverage`

## Code of Conduct

Be respectful, constructive, and inclusive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

## Questions?

Open a Discussion on GitHub or reach out to the maintainers.
