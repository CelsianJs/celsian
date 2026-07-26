import { CELSIAN_VERSION, DEV_DEPS } from "../versions.js";

export const basicTemplate = {
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

app.get('/health', (req, reply) => {
  return reply.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/hello/:name', (req, reply) => {
  return reply.json({ message: \`Hello, \${req.params.name}!\` });
});

// Start a listening server only when this file IS the process entry point.
// Tests, serverless handlers and \`celsian routes\` import \`app\` and drive it
// directly, and must not bind a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(app);
}
`,
  "test/app.test.ts": `import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';

// app.inject() drives the app in-process: no HTTP server, no open port.
describe('routes', () => {
  it('GET /health reports ok', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('timestamp');
  });

  it('GET /hello/:name greets by name', async () => {
    const res = await app.inject({ url: '/hello/Ada' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Hello, Ada!' });
  });

  it('returns 404 for an unknown route', async () => {
    const res = await app.inject({ url: '/nope' });
    expect(res.status).toBe(404);
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

A minimal API server built with [CelsianJS](https://github.com/CelsianJs/celsian).

## Quick Start

\`\`\`bash
npm install
npm run dev
\`\`\`

The server starts at http://localhost:3000.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/health\` | Server health check |
| GET | \`/hello/:name\` | Greeting by name |

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

const res = await app.inject({ url: '/health' });
const body = await res.json();
// body.status === 'ok'
\`\`\`
`,
};
