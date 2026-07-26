import { CELSIAN_VERSION, DEPS, DEV_DEPS } from "../versions.js";

export const restApiTemplate = {
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

// Note: TypeBox string formats (e.g. { format: 'email' }) require registering
// the format in TypeBox's FormatRegistry first: a plain pattern keeps this
// template self-contained and working out of the box.
const CreateUserSchema = Type.Object({
  name: Type.String(),
  email: Type.String({ pattern: '^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+$' }),
});

const users: Array<{ id: number; name: string; email: string }> = [];
let nextId = 1;

app.get('/users', (req, reply) => {
  return reply.json(users);
});

app.post('/users', {
  schema: { body: CreateUserSchema },
}, (req, reply) => {
  const { name, email } = req.parsedBody as { name: string; email: string };
  const user = { id: nextId++, name, email };
  users.push(user);
  return reply.status(201).json(user);
});

app.get('/users/:id', (req, reply) => {
  const user = users.find(u => u.id === Number(req.params.id));
  if (!user) return reply.status(404).json({ error: 'User not found' });
  return reply.json(user);
});

// Start a listening server only when this file IS the process entry point.
// Tests, serverless handlers and \`celsian routes\` import \`app\` and drive it
// directly, and must not bind a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(app);
}
`,
  "test/users.test.ts": `import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';

// app.inject() drives the app in-process: no HTTP server, no open port.
describe('users', () => {
  it('POST /users creates a user and GET /users lists it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { name: 'Ada', email: 'ada@example.com' },
    });
    expect(created.status).toBe(201);
    const user = await created.json();
    expect(user).toMatchObject({ name: 'Ada', email: 'ada@example.com' });
    expect(user).toHaveProperty('id');

    const list = await app.inject({ url: '/users' });
    expect(list.status).toBe(200);
    const users = await list.json();
    expect(users.some((u: { id: number }) => u.id === user.id)).toBe(true);
  });

  it('POST /users rejects an invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { name: 'Bad', email: 'not-an-email' },
    });
    expect(res.status).toBe(400);
  });

  it('GET /users/:id returns 404 for an unknown id', async () => {
    const res = await app.inject({ url: '/users/999999' });
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

A REST API built with [CelsianJS](https://github.com/CelsianJs/celsian) and TypeBox schema validation.

## Quick Start

\`\`\`bash
npm install
npm run dev
\`\`\`

The server starts at http://localhost:3000.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/users\` | List all users |
| POST | \`/users\` | Create a user (\`{ "name": "...", "email": "..." }\`) |
| GET | \`/users/:id\` | Get a user by ID |

\`\`\`bash
curl -X POST http://localhost:3000/users \\
  -H 'content-type: application/json' \\
  -d '{"name":"Ada","email":"ada@example.com"}'
\`\`\`

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

const res = await app.inject({
  method: 'POST',
  url: '/users',
  payload: { name: 'Ada', email: 'ada@example.com' },
});
// res.status === 201
\`\`\`
`,
};
