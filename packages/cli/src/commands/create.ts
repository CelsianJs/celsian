// @celsian/cli — celsian create command

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

export type Template = "basic" | "rest-api" | "rpc-api";

export async function createCommand(name: string, template: Template = "basic"): Promise<void> {
  const dir = join(process.cwd(), name);

  logger.info(`Creating project: ${name} (template: ${template})`);

  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "0.0.1",
        type: "module",
        scripts: {
          dev: "celsian dev",
          build: "tsc",
          start: "node dist/index.js",
        },
        dependencies: {
          celsian: "^0.3.18",
          ...(template === "rpc-api" ? { "@celsian/rpc": "^0.3.18" } : {}),
          ...(template !== "basic" ? { "@sinclair/typebox": "^0.34.0" } : {}),
        },
        devDependencies: {
          typescript: "^5.7.0",
          tsx: "^4.0.0",
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
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
  );

  const entryContent = getTemplateContent(template);
  writeFileSync(join(dir, "src/index.ts"), entryContent);

  logger.success(`Project created at ./${name}`);
  logger.dim(`  cd ${name}`);
  logger.dim("  npm install");
  logger.dim("  npm run dev");
}

function getTemplateContent(template: Template): string {
  switch (template) {
    case "basic":
      return `import { createApp, serve } from 'celsian';

const app = createApp();

app.get('/health', (req, reply) => {
  return reply.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/hello/:name', (req, reply) => {
  return reply.json({ message: \`Hello, \${req.params.name}!\` });
});

serve(app);
`;

    case "rest-api":
      return `import { createApp, serve } from 'celsian';
import { Type } from '@sinclair/typebox';

const app = createApp();

// TypeBox schemas for validation
const CreateUserSchema = Type.Object({
  name: Type.String(),
  email: Type.String({ format: 'email' }),
});

const users: Array<{ id: number; name: string; email: string }> = [];
let nextId = 1;

app.get('/users', (req, reply) => {
  return reply.json(users);
});

app.route({
  method: 'POST',
  url: '/users',
  schema: { body: CreateUserSchema },
  handler(req, reply) {
    const { name, email } = req.parsedBody as { name: string; email: string };
    const user = { id: nextId++, name, email };
    users.push(user);
    return reply.status(201).json(user);
  },
});

app.get('/users/:id', (req, reply) => {
  const user = users.find(u => u.id === Number(req.params.id));
  if (!user) return reply.status(404).json({ error: 'User not found' });
  return reply.json(user);
});

serve(app);
`;

    case "rpc-api":
      return `import { createApp, serve } from 'celsian';
import { procedure, router, RPCHandler } from '@celsian/rpc';
import { Type } from '@sinclair/typebox';

const app = createApp();

// Define procedures
const appRouter = router({
  greeting: {
    hello: procedure
      .input<{ name: string }>(Type.Object({ name: Type.String() }))
      .query(({ input }) => {
        return { message: \`Hello, \${input.name}!\` };
      }),
  },
  math: {
    add: procedure
      .input<{ a: number; b: number }>(Type.Object({ a: Type.Number(), b: Type.Number() }))
      .query(({ input }) => {
        return { result: input.a + input.b };
      }),
  },
});

// Mount RPC handler
const rpcHandler = new RPCHandler(appRouter);

app.route({
  method: ['GET', 'POST'],
  url: '/_rpc/*path',
  handler(req) {
    return rpcHandler.handle(req);
  },
});

serve(app);

// Export type for client
export type AppRouter = typeof appRouter;
`;
    default:
      throw new Error(`Unknown template: ${template}`);
  }
}
