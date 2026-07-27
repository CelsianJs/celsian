import { CELSIAN_VERSION, DEPS, DEV_DEPS } from "../versions.js";

export const rpcApiTemplate = {
  "package.json": JSON.stringify(
    {
      name: "{{name}}",
      version: "0.0.1",
      type: "module",
      scripts: {
        // tsx forwards --env-file to Node, so .env is loaded for PORT/CORS_ORIGIN
        dev: "npx tsx --env-file=.env --watch src/index.ts",
        build: "tsc",
        start: "node --env-file=.env dist/index.js",
        test: "npx vitest run",
        lint: "npx tsc --noEmit",
      },
      dependencies: {
        celsian: CELSIAN_VERSION,
        "@celsian/rpc": CELSIAN_VERSION,
        "@sinclair/typebox": DEPS.typebox,
      },
      devDependencies: {
        typescript: DEV_DEPS.typescript,
        tsx: DEV_DEPS.tsx,
        vitest: DEV_DEPS.vitest,
        "@types/node": DEV_DEPS.typesNode,
      },
    },
    null,
    2,
  ),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src"],
    },
    null,
    2,
  ),
  "src/index.ts": `import { pathToFileURL } from 'node:url';
import { createApp, serve, cors, security } from 'celsian';
import { procedure, router, RPCHandler } from '@celsian/rpc';
import { Type } from '@sinclair/typebox';

// Exported so tooling like \`celsian routes\` can discover the app.
export const app = createApp();

// ─── Security (CORS + security headers) ───

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

await app.register(cors({
  origin: CORS_ORIGIN,
  credentials: true,
  maxAge: 86400,
}));

await app.register(security({
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: 'strict-origin-when-cross-origin',
}));

// ─── Routes ───

const appRouter = router({
  greeting: {
    hello: procedure
      .input(Type.Object({ name: Type.String() }))
      .query(({ input }) => {
        return { message: 'Hello, ' + input.name + '!' };
      }),
  },
  math: {
    add: procedure
      .input(Type.Object({ a: Type.Number(), b: Type.Number() }))
      .query(({ input }) => {
        return { result: input.a + input.b };
      }),
  },
});

const rpcHandler = new RPCHandler(appRouter);

app.route({
  method: ['GET', 'POST'],
  url: '/_rpc/*path',
  handler(req) {
    return rpcHandler.handle(req);
  },
});

// Start a listening server only when this file IS the process entry point.
// Tests, serverless handlers and \`celsian routes\` import \`app\` and drive it
// directly, and must not bind a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(app);
}

export type AppRouter = typeof appRouter;
`,
  "test/rpc.test.ts": `import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';

// app.inject() drives the app in-process: no HTTP server, no open port.
const withInput = (path: string, input: unknown) =>
  path + '?input=' + encodeURIComponent(JSON.stringify(input));

describe('rpc procedures', () => {
  it('greeting.hello returns a greeting', async () => {
    const res = await app.inject({ url: withInput('/_rpc/greeting.hello', { name: 'Ada' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.message).toBe('Hello, Ada!');
  });

  it('math.add sums its inputs', async () => {
    const res = await app.inject({ url: withInput('/_rpc/math.add', { a: 2, b: 3 }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.result).toBe(5);
  });

  it('rejects input that does not match the schema', async () => {
    const res = await app.inject({ url: withInput('/_rpc/math.add', { a: 'nope', b: 3 }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
`,
  ".env": `PORT=3000
CORS_ORIGIN=http://localhost:3000
`,
  ".gitignore": `node_modules/
dist/
*.tsbuildinfo
.env
`,
  "README.md": `# {{name}}

An RPC-first API built with [CelsianJS](https://github.com/CelsianJs/celsian) and \`@celsian/rpc\`.

## Quick Start

\`\`\`bash
npm install
npm run dev
\`\`\`

The server starts at http://localhost:3000. All procedures are served under \`/_rpc/*\`.

## Procedures

| Kind | Path | Input |
|------|------|-------|
| query | \`/_rpc/greeting.hello\` | \`{ "name": "..." }\` |
| query | \`/_rpc/math.add\` | \`{ "a": 1, "b": 2 }\` |

\`\`\`bash
curl 'http://localhost:3000/_rpc/math.add?input=%7B%22a%22%3A1%2C%22b%22%3A2%7D'
\`\`\`

The \`AppRouter\` type is exported from \`src/index.ts\` for end-to-end typed clients.

## Scripts

- \`npm run dev\` -- start the dev server with hot reload (loads \`.env\`)
- \`npm run build\` -- compile TypeScript to \`dist/\`
- \`npm start\` -- run the compiled server
- \`npm test\` -- run the Vitest suite in \`test/\`
- \`npm run lint\` -- typecheck \`src/\` with \`tsc --noEmit\`

## Testing

Tests use \`app.inject()\`, so no HTTP server is started:

\`\`\`typescript
import { app } from '../src/index.js';

const input = encodeURIComponent(JSON.stringify({ a: 2, b: 3 }));
const res = await app.inject({ url: \`/_rpc/math.add?input=\${input}\` });
const body = await res.json();
// body.result.result === 5
\`\`\`
`,
};
