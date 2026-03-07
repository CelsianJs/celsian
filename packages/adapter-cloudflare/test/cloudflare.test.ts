import { describe, it, expect } from 'vitest';
import { createApp } from '@celsian/core';
import { cors } from '@celsian/core';
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

function makeRequest(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

async function handle(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const handler = createCloudflareHandler(app);
  return handler.fetch(makeRequest(path, init), createMockEnv(), createMockCtx());
}

describe('@celsian/adapter-cloudflare', () => {
  it('should create a Cloudflare handler', () => {
    const app = createApp();
    const handler = createCloudflareHandler(app);
    expect(handler).toBeDefined();
    expect(typeof handler.fetch).toBe('function');
  });

  it('should handle GET requests', async () => {
    const app = createApp();
    app.get('/hello', (_req, reply) => reply.json({ message: 'hello' }));

    const response = await handle(app, '/hello');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'hello' });
  });

  it('should parse URL params', async () => {
    const app = createApp();
    app.get('/users/:id', (req, reply) => reply.json({ id: req.params.id }));

    const response = await handle(app, '/users/42');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: '42' });
  });

  it('should parse query strings', async () => {
    const app = createApp();
    app.get('/search', (req, reply) => reply.json({ q: req.query.q }));

    const response = await handle(app, '/search?q=test');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ q: 'test' });
  });

  it('should handle POST with JSON body', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ received: req.parsedBody }));

    const response = await handle(app, '/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: { name: 'test' } });
  });

  it('should return 404 for unmatched routes', async () => {
    const app = createApp();
    const response = await handle(app, '/nope');
    expect(response.status).toBe(404);
  });

  it('should return 405 for wrong method', async () => {
    const app = createApp();
    app.get('/only-get', (_req, reply) => reply.json({ ok: true }));

    const response = await handle(app, '/only-get', { method: 'POST' });
    expect(response.status).toBe(405);
  });

  it('should handle HEAD requests (fallback to GET)', async () => {
    const app = createApp();
    app.get('/hello', (_req, reply) => reply.json({ message: 'hello' }));

    const response = await handle(app, '/hello', { method: 'HEAD' });
    expect(response.status).toBe(200);
  });

  it('should reject oversized body', async () => {
    const app = createApp({ bodyLimit: 100 });
    app.post('/data', (req, reply) => reply.json({ ok: true }));

    const response = await handle(app, '/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '1000000' },
      body: JSON.stringify({ big: 'x'.repeat(1000) }),
    });
    expect(response.status).toBe(413);
  });

  it('should return 400 for malformed JSON', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ ok: true }));

    const response = await handle(app, '/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken json',
    });
    expect(response.status).toBe(400);
  });

  it('should pass env bindings on request', async () => {
    const app = createApp();
    app.get('/config', (req, reply) => {
      const env = (req as any).env;
      return reply.json({ db: env?.DATABASE_URL });
    });

    const handler = createCloudflareHandler(app);
    const response = await handler.fetch(
      makeRequest('/config'),
      createMockEnv({ DATABASE_URL: 'postgres://localhost/db' }),
      createMockCtx(),
    );
    expect(await response.json()).toEqual({ db: 'postgres://localhost/db' });
  });

  it('should pass execution context on request', async () => {
    const app = createApp();
    let hasCtx = false;
    app.get('/ctx', (req, reply) => {
      hasCtx = typeof (req as any).ctx?.waitUntil === 'function';
      return reply.json({ ok: true });
    });

    const handler = createCloudflareHandler(app);
    await handler.fetch(makeRequest('/ctx'), createMockEnv(), createMockCtx());
    expect(hasCtx).toBe(true);
  });

  it('should handle custom response headers', async () => {
    const app = createApp();
    app.get('/headers', (_req, reply) => reply.header('x-custom', 'value').json({ ok: true }));

    const response = await handle(app, '/headers');
    expect(response.headers.get('x-custom')).toBe('value');
  });

  it('should handle error responses', async () => {
    const app = createApp();
    app.get('/error', () => { throw new Error('boom'); });

    const response = await handle(app, '/error');
    expect(response.status).toBe(500);
  });

  it('should handle CORS with plugin', async () => {
    const app = createApp();
    await app.register(cors({ origin: '*' }));
    app.get('/api', (_req, reply) => reply.json({ ok: true }));

    const response = await handle(app, '/api', {
      headers: { origin: 'http://example.com' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('should handle CORS preflight (OPTIONS)', async () => {
    const app = createApp();
    await app.register(cors({ origin: '*' }));
    app.get('/api', (_req, reply) => reply.json({ ok: true }));

    const response = await handle(app, '/api', {
      method: 'OPTIONS',
      headers: { origin: 'http://example.com', 'access-control-request-method': 'GET' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBeTruthy();
  });
});
