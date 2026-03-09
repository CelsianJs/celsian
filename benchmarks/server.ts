// benchmarks/server.ts — CelsianJS benchmark target server
//
// Sets up a CelsianJS app with all benchmark routes and starts it.
// Usage: import { startBenchServer } from './server.ts'

import { createApp, serve } from '@celsian/core';

export async function startBenchServer(port: number): Promise<{ close: () => Promise<void> }> {
  const app = createApp();

  // ─── Scenario 1: JSON hello ───
  app.get('/json', (_req, reply) => {
    return reply.json({ message: 'Hello, World!' });
  });

  // ─── Scenario 2: Route params ───
  app.get('/user/:id', (req, reply) => {
    return reply.json({ id: req.params.id, name: `User ${req.params.id}`, email: `user${req.params.id}@test.com` });
  });

  // ─── Scenario 3: Middleware/hooks chain (5 layers) ───
  app.route({
    method: 'GET',
    url: '/middleware',
    onRequest: [
      (_req, reply) => { reply.header('x-mw-1', 'true'); },
      (_req, reply) => { reply.header('x-mw-2', 'true'); },
      (_req, reply) => { reply.header('x-mw-3', 'true'); },
      (_req, reply) => { reply.header('x-mw-4', 'true'); },
      (_req, reply) => { reply.header('x-mw-5', 'true'); },
    ],
    handler: (_req, reply) => {
      return reply.json({ middleware: 'ok' });
    },
  });

  // ─── Scenario 4: Body parse ───
  app.post('/echo', (req, reply) => {
    return reply.json(req.parsedBody);
  });

  // ─── Scenario 5: Error handling ───
  app.get('/error', () => {
    throw new Error('Intentional benchmark error');
  });

  // Wait for plugins/hooks to resolve, then start the server.
  return new Promise<{ close: () => Promise<void> }>((resolve) => {
    let serverResult: Awaited<ReturnType<typeof serve>>;

    const started = serve(app, {
      port,
      host: '127.0.0.1',
      onReady: () => {
        resolve({ close: () => serverResult.close() });
      },
    });

    started.then((s) => {
      serverResult = s;
    });
  });
}
