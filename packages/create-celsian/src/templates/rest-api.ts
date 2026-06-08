import { CELSIAN_VERSION, DEPS, DEV_DEPS } from "../versions.js";

export const restApiTemplate = {
  "package.json": JSON.stringify(
    {
      name: "{{name}}",
      version: "0.0.1",
      type: "module",
      scripts: {
        dev: "npx tsx --watch src/index.ts",
        build: "tsc",
        start: "node dist/index.js",
      },
      dependencies: {
        celsian: CELSIAN_VERSION,
        "@sinclair/typebox": DEPS.typebox,
      },
      devDependencies: {
        typescript: DEV_DEPS.typescript,
        tsx: DEV_DEPS.tsx,
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
  "src/index.ts": `import { createApp, serve, cors, security } from 'celsian';
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

const CreateUserSchema = Type.Object({
  name: Type.String(),
  email: Type.String({ format: 'email' }),
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

serve(app);
`,
};
