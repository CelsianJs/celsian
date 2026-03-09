// benchmarks/server-express.ts — Express benchmark target
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import http from 'node:http';

export async function startExpressServer(port: number): Promise<{ close: () => Promise<void> }> {
  const app = express();

  app.use(express.json());

  // ─── Scenario 1: JSON hello ───
  app.get('/json', (_req: Request, res: Response) => {
    res.json({ message: 'Hello, World!' });
  });

  // ─── Scenario 2: Params ───
  app.get('/user/:id', (req: Request, res: Response) => {
    res.json({ id: req.params.id, name: `User ${req.params.id}`, email: `user${req.params.id}@test.com` });
  });

  // ─── Scenario 3: Middleware chain (5 layers) ───
  const mw1 = (_req: Request, res: Response, next: NextFunction) => { res.setHeader('x-mw-1', 'true'); next(); };
  const mw2 = (_req: Request, res: Response, next: NextFunction) => { res.setHeader('x-mw-2', 'true'); next(); };
  const mw3 = (_req: Request, res: Response, next: NextFunction) => { res.setHeader('x-mw-3', 'true'); next(); };
  const mw4 = (_req: Request, res: Response, next: NextFunction) => { res.setHeader('x-mw-4', 'true'); next(); };
  const mw5 = (_req: Request, res: Response, next: NextFunction) => { res.setHeader('x-mw-5', 'true'); next(); };

  app.get('/middleware', mw1, mw2, mw3, mw4, mw5, (_req: Request, res: Response) => {
    res.json({ middleware: 'ok' });
  });

  // ─── Scenario 4: Body parse (POST /echo) ───
  app.post('/echo', (req: Request, res: Response) => {
    res.json(req.body);
  });

  // ─── Scenario 5: Error handling ───
  app.get('/error', (_req: Request, _res: Response) => {
    throw new Error('Intentional benchmark error');
  });

  // Error handler middleware
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return new Promise<{ close: () => Promise<void> }>((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      resolve({
        close: async () => {
          await new Promise<void>((res, rej) => server.close((err) => err ? rej(err) : res()));
        },
      });
    });
  });
}
