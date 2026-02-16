// benchmarks/server.ts — CelsianJS benchmark target server
//
// Sets up a CelsianJS app with all benchmark routes and starts it.
// Usage: import { startBenchServer } from './server.ts'

import { createApp, serve } from '@celsian/core';

export async function startBenchServer(port: number): Promise<{ close: () => Promise<void> }> {
  const app = createApp();

  // ─── Scenario 1: JSON hello ───
  // Measures raw framework overhead for the simplest possible response.
  app.get('/json', (_req, reply) => {
    return reply.json({ message: 'Hello, World!' });
  });

  // ─── Scenario 2: Params ───
  // Measures router matching + param extraction.
  app.get('/users/:id', (req, reply) => {
    return reply.json({ id: req.params.id });
  });

  // ─── Scenario 3: Body parse ───
  // Measures JSON body parsing + echo.
  app.post('/echo', (req, reply) => {
    return reply.json(req.parsedBody);
  });

  // ─── Scenario 4: Hooks chain ───
  // Measures the cost of running 3 onRequest hooks before the handler.
  app.route({
    method: 'GET',
    url: '/hooks',
    onRequest: [
      (_req, reply) => { reply.header('x-hook-1', 'true'); },
      (_req, reply) => { reply.header('x-hook-2', 'true'); },
      (_req, reply) => { reply.header('x-hook-3', 'true'); },
    ],
    handler: (_req, reply) => {
      return reply.json({ hooks: 'ok' });
    },
  });

  // ─── Scenario 5: Not found ───
  // The 404 handler is built into CelsianApp.handle() — no route needed.

  // Wait for plugins/hooks to resolve, then start the server.
  // Use onReady to ensure the server is actually bound before returning.
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
