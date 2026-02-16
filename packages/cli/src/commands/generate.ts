// @celsian/cli — celsian generate command

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from '../utils/logger.js';

export function generateRoute(name: string): void {
  const filePath = join(process.cwd(), 'src', 'routes', `${name}.ts`);
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
  const filePath = join(process.cwd(), 'src', 'rpc', `${name}.ts`);
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
    `import { procedure } from '@celsian/rpc';

export const ${name} = {
  list: procedure.query(async () => {
    return [];
  }),

  getById: procedure.query(async ({ input }) => {
    return { id: input };
  }),

  create: procedure.mutation(async ({ input }) => {
    return { created: true, data: input };
  }),
};
`,
  );

  logger.success(`Generated RPC procedure: src/rpc/${name}.ts`);
}
