import { describe, it, expect } from 'vitest';
import { createApp } from '@celsian/core';
import { createCloudflareHandler, type CloudflareEnv, type ExecutionContext } from '../src/index.js';

function createMockEnv(bindings: Record<string, unknown> = {}): CloudflareEnv {
  return bindings;
}

function createMockCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  };
}

describe('@celsian/adapter-cloudflare', () => {
  it('should create a Cloudflare handler', () => {
    const app = createApp();
    const handler = createCloudflareHandler(app);
    expect(handler).toBeDefined();
    expect(typeof handler.fetch).toBe('function');
  });

  it('should handle requests', async () => {
    const app = createApp();
    app.get('/hello', (_req, reply) => reply.json({ message: 'hello' }));

    const handler = createCloudflareHandler(app);
    const response = await handler.fetch(
      new Request('http://localhost/hello'),
      createMockEnv(),
      createMockCtx(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ message: 'hello' });
  });

  it('should pass env bindings on request', async () => {
    const app = createApp();
    app.get('/config', (req, reply) => {
      const env = (req as any).env;
      return reply.json({ db: env?.DATABASE_URL });
    });

    const handler = createCloudflareHandler(app);
    const response = await handler.fetch(
      new Request('http://localhost/config'),
      createMockEnv({ DATABASE_URL: 'postgres://localhost/db' }),
      createMockCtx(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ db: 'postgres://localhost/db' });
  });

  it('should pass execution context on request', async () => {
    const app = createApp();
    let hasCtx = false;

    app.get('/ctx', (req, reply) => {
      hasCtx = typeof (req as any).ctx?.waitUntil === 'function';
      return reply.json({ ok: true });
    });

    const handler = createCloudflareHandler(app);
    await handler.fetch(
      new Request('http://localhost/ctx'),
      createMockEnv(),
      createMockCtx(),
    );

    expect(hasCtx).toBe(true);
  });

  it('should return 404 for unmatched routes', async () => {
    const app = createApp();
    const handler = createCloudflareHandler(app);

    const response = await handler.fetch(
      new Request('http://localhost/nope'),
      createMockEnv(),
      createMockCtx(),
    );

    expect(response.status).toBe(404);
  });
});
