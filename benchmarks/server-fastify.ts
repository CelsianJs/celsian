// benchmarks/server-fastify.ts — Fastify benchmark target
import Fastify from 'fastify';

export async function startFastifyServer(port: number): Promise<{ close: () => Promise<void> }> {
  const app = Fastify({ logger: false });

  app.get('/json', async () => ({ message: 'Hello, World!' }));

  app.get('/users/:id', async (req) => ({ id: (req.params as any).id }));

  app.post('/echo', async (req) => req.body);

  app.get('/hooks', {
    onRequest: [
      async (_req, reply) => { reply.header('x-hook-1', 'true'); },
      async (_req, reply) => { reply.header('x-hook-2', 'true'); },
      async (_req, reply) => { reply.header('x-hook-3', 'true'); },
    ],
    handler: async () => ({ hooks: 'ok' }),
  });

  await app.listen({ port, host: '127.0.0.1' });

  return {
    close: async () => { await app.close(); },
  };
}
