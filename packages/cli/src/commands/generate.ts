// @celsian/cli — celsian generate command

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";

export function generateRoute(name: string): void {
  const filePath = join(process.cwd(), "src", "routes", `${name}.ts`);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(filePath)) {
    logger.error(`File already exists: ${filePath}`);
    return;
  }

  writeFileSync(
    filePath,
    `import type { PluginFunction } from '@celsian/core';

const ${name}Routes: PluginFunction = async (app) => {
  app.get('/${name}', (req, reply) => {
    return reply.json({ message: '${name} route' });
  });

  app.get('/${name}/:id', (req, reply) => {
    return reply.json({ id: req.params.id });
  });
};

export default ${name}Routes;
`,
  );

  logger.success(`Generated route: src/routes/${name}.ts`);
}

export function generateRpc(name: string): void {
  // RPC procedures live alongside routes in `src/routes/` to match the
  // convention shipped by the create-celsian scaffold (e.g. src/routes/rpc.ts).
  const filePath = join(process.cwd(), "src", "routes", `${name}.ts`);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(filePath)) {
    logger.error(`File already exists: ${filePath}`);
    return;
  }

  writeFileSync(
    filePath,
    `import type { PluginFunction } from '@celsian/core';
import { procedure, RPCHandler, router } from '@celsian/rpc';

// RPC procedures for the "${name}" namespace. Add \`.input(schema)\` (Zod,
// TypeBox, or Valibot) before \`.query\`/\`.mutation\` to validate and type \`input\`
// — without a schema, \`input\` is \`unknown\`.
export const ${name}Router = router({
  ${name}: {
    list: procedure.query(async () => {
      return [] as Array<{ id: string }>;
    }),

    getById: procedure
      // .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        return { item: input };
      }),

    create: procedure
      // .input(z.object({ name: z.string() }))
      .mutation(async ({ input }) => {
        return { created: true, data: input };
      }),
  },
});

// Register on your Celsian app. In src/index.ts:
//   import ${name}Rpc from './routes/${name}.js';
//   await app.register(${name}Rpc);
// Procedures are served under \`/_rpc/*\` — GET for queries, POST for mutations
// (e.g. GET /_rpc/${name}.list).
const ${name}Rpc: PluginFunction = async (app) => {
  new RPCHandler(${name}Router).mount(app);
};

export default ${name}Rpc;
`,
  );

  logger.success(`Generated RPC procedure: src/routes/${name}.ts`);
}
