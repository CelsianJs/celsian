// benchmarks/server-fastify.ts — Fastify benchmark target
import Fastify from 'fastify';

export async function startFastifyServer(port: number): Promise<{ close: () => Promise<void> }> {
  const app = Fastify({ logger: false });

  // ─── Scenario 1: JSON hello ───
  app.get('/json', async () => ({ message: 'Hello, World!' }));

  // ─── Scenario 2: Route params ───
  app.get('/user/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { id, name: `User ${id}`, email: `user${id}@test.com` };
  });

  // ─── Scenario 3: Middleware/hooks chain (5 layers) ───
  app.get('/middleware', {
    onRequest: [
      async (_req, reply) => { reply.header('x-mw-1', 'true'); },
      async (_req, reply) => { reply.header('x-mw-2', 'true'); },
      async (_req, reply) => { reply.header('x-mw-3', 'true'); },
      async (_req, reply) => { reply.header('x-mw-4', 'true'); },
      async (_req, reply) => { reply.header('x-mw-5', 'true'); },
    ],
    handler: async () => ({ middleware: 'ok' }),
  });

  // ─── Scenario 4: Body parse ───
  app.post('/echo', async (req) => req.body);

  // ─── Scenario 5: Error handling ───
  app.get('/error', async () => {
    throw new Error('Intentional benchmark error');
  });

  app.setErrorHandler(async (error, _req, reply) => {
    reply.status(500).send({ error: error.message });
  });

  await app.listen({ port, host: '127.0.0.1' });

  return {
    close: async () => { await app.close(); },
  };
}
