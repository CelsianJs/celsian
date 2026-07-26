# CelsianJS Documentation

CelsianJS is a TypeScript-first backend framework built on Web Standard `Request` and
`Response`. `@celsian/core` has no third-party runtime dependencies, and the same
application runs on Node, Bun, Deno, Cloudflare Workers, AWS Lambda, Vercel, Fly.io and
Railway.

## Start here

| Guide | What it covers |
| --- | --- |
| [Quick Start](quickstart.md) | Install, first route, first server. |
| [Migrating from Fastify](migration-from-fastify.md) | Side-by-side conversion of routes, hooks, plugins, decorators, validation and error handling. The fastest route in if you already know Fastify. |

## Core concepts

| Guide | What it covers |
| --- | --- |
| [Hooks Lifecycle](hooks.md) | The 8-hook request lifecycle, route-level hooks, and where errors go. |
| [Plugins and Encapsulation](plugins.md) | Scoped plugins, `{ encapsulate: false }`, and app/request/reply decorators. |
| [Error Reference](errors.md) | Every error `code`, its cause, and how to fix it. |

## Features

| Guide | What it covers |
| --- | --- |
| [Server-Sent Events](sse.md) | Single streams and broadcast hubs, on every runtime. |
| [Database Plugin](database.md) | Connection pooling, transactions, query analytics and `Server-Timing`. |

## Shipping

| Guide | What it covers |
| --- | --- |
| [Deployment Guide](deployment.md) | Per-platform entry points and adapters for all eight supported targets. |

## Elsewhere

- [Root README](../README.md) for the feature overview and package list.
- [CHANGELOG](../CHANGELOG.md) for release history.
- [SECURITY.md](../SECURITY.md) to report a vulnerability.
- Per-package READMEs under `packages/*/README.md` for API-level detail.

Internal working documents (audits, sprint plans, QA harnesses) live in `internal/` at the
repository root, deliberately outside this published documentation path.
