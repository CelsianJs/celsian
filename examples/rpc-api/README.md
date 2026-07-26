# CelsianJS, type-safe RPC

Exposes a nested router of procedures over HTTP with `@celsian/rpc`, and
exports the router type so a client can be typed end to end.

## What it demonstrates

- `router()` and `procedure.input(...).query(...)`
- Mounting an `RPCHandler` on a Celsian app
- Input validation on procedures (TypeBox here)
- `export type AppRouter`, the type a generated client consumes

## Run it

Install once from the monorepo root (the example depends on workspace packages):

```bash
pnpm install
```

Then, from this directory:

```bash
pnpm dev            # tsx src/index.ts
celsian routes      # list routes without starting a server (needs @celsian/cli)
```

Server starts at http://localhost:3000. Override with `PORT`.

## Endpoints

Procedures live under `/_rpc` and are addressed by their dotted path. Queries
take their input as a JSON-encoded `input` query parameter; mutations take a
JSON body over POST.

| Method | Path | Description |
|--------|------|-------------|
| GET | /_rpc/greeting.hello | `{ name: string }` -> greeting |
| GET | /_rpc/math.add | `{ a: number, b: number }` -> sum |
| GET | /_rpc/manifest.json | Procedure manifest |
| GET | /_rpc/openapi.json | OpenAPI document for the router |

## Try it

```bash
curl 'http://localhost:3000/_rpc/greeting.hello?input=%7B%22name%22%3A%22Ada%22%7D'
# {"result":{"message":"Hello, Ada!"}}

curl 'http://localhost:3000/_rpc/math.add?input=%7B%22a%22%3A2%2C%22b%22%3A3%7D'
# {"result":{"result":5}}

curl http://localhost:3000/_rpc/manifest.json

# Invalid input returns a structured VALIDATION_ERROR
curl 'http://localhost:3000/_rpc/math.add?input=%7B%22a%22%3A%22x%22%7D'
```

## Not included

The typed client is not wired up here: this example only shows the server side
and the exported `AppRouter` type. See the `@celsian/rpc` docs for
`createRPCClient`.
