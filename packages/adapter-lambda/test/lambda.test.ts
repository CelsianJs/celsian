import { describe, it, expect } from 'vitest';
import { createApp } from '@celsian/core';
import { cors } from '@celsian/core';
import { createLambdaHandler, type APIGatewayProxyEventV2 } from '../src/index.js';

function createEvent(overrides: Partial<APIGatewayProxyEventV2> & { method?: string } = {}): APIGatewayProxyEventV2 {
  const method = overrides.method ?? overrides.requestContext?.http?.method ?? 'GET';
  const path = overrides.rawPath ?? '/hello';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: overrides.rawQueryString ?? '',
    headers: overrides.headers ?? { host: 'api.example.com' },
    body: overrides.body,
    isBase64Encoded: overrides.isBase64Encoded ?? false,
    requestContext: overrides.requestContext ?? {
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'test-request-id',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
  };
}

describe('@celsian/adapter-lambda', () => {
  it('should create a Lambda handler', () => {
    const app = createApp();
    const handler = createLambdaHandler(app);
    expect(typeof handler).toBe('function');
  });

  it('should handle GET requests', async () => {
    const app = createApp();
    app.get('/hello', (_req, reply) => reply.json({ message: 'hello' }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ message: 'hello' });
  });

  it('should parse URL params', async () => {
    const app = createApp();
    app.get('/users/:id', (req, reply) => reply.json({ id: req.params.id }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({ rawPath: '/users/42' }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ id: '42' });
  });

  it('should handle POST with JSON body', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ received: req.parsedBody }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({
      rawPath: '/data',
      method: 'POST',
      headers: { host: 'api.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
      requestContext: {
        http: { method: 'POST', path: '/data', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
        requestId: 'test-2', time: new Date().toISOString(), timeEpoch: Date.now(),
      },
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ received: { name: 'test' } });
  });

  it('should return 404 for unmatched routes', async () => {
    const app = createApp();
    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({ rawPath: '/nope' }));
    expect(result.statusCode).toBe(404);
  });

  it('should return 405 for wrong method', async () => {
    const app = createApp();
    app.get('/only-get', (_req, reply) => reply.json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({
      rawPath: '/only-get',
      method: 'POST',
      requestContext: {
        http: { method: 'POST', path: '/only-get', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
        requestId: 'test-405', time: new Date().toISOString(), timeEpoch: Date.now(),
      },
    }));
    expect(result.statusCode).toBe(405);
  });

  it('should handle HEAD requests (fallback to GET)', async () => {
    const app = createApp();
    app.get('/hello', (_req, reply) => reply.json({ message: 'hello' }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({
      method: 'HEAD',
      requestContext: {
        http: { method: 'HEAD', path: '/hello', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
        requestId: 'test-head', time: new Date().toISOString(), timeEpoch: Date.now(),
      },
    }));
    expect(result.statusCode).toBe(200);
  });

  it('should include response headers', async () => {
    const app = createApp();
    app.get('/hello', (_req, reply) => reply.header('x-custom', 'value').json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent());
    expect(result.headers?.['x-custom']).toBe('value');
  });

  it('should handle base64 encoded body', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ received: req.parsedBody }));

    const handler = createLambdaHandler(app);
    const body = JSON.stringify({ encoded: true });
    const result = await handler(createEvent({
      rawPath: '/data',
      method: 'POST',
      headers: { host: 'api.example.com', 'content-type': 'application/json' },
      body: Buffer.from(body).toString('base64'),
      isBase64Encoded: true,
      requestContext: {
        http: { method: 'POST', path: '/data', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
        requestId: 'test-3', time: new Date().toISOString(), timeEpoch: Date.now(),
      },
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ received: { encoded: true } });
  });

  it('should handle query string parameters', async () => {
    const app = createApp();
    app.get('/search', (req, reply) => reply.json({ q: req.query.q }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({ rawPath: '/search', rawQueryString: 'q=hello' }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ q: 'hello' });
  });

  it('should reject oversized body', async () => {
    const app = createApp({ bodyLimit: 100 });
    app.post('/data', (req, reply) => reply.json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({
      rawPath: '/data',
      method: 'POST',
      headers: { host: 'api.example.com', 'content-type': 'application/json', 'content-length': '1000000' },
      body: JSON.stringify({ big: 'x'.repeat(1000) }),
      requestContext: {
        http: { method: 'POST', path: '/data', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
        requestId: 'test-413', time: new Date().toISOString(), timeEpoch: Date.now(),
      },
    }));
    expect(result.statusCode).toBe(413);
  });

  it('should return 400 for malformed JSON', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({
      rawPath: '/data',
      method: 'POST',
      headers: { host: 'api.example.com', 'content-type': 'application/json' },
      body: '{broken json',
      requestContext: {
        http: { method: 'POST', path: '/data', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
        requestId: 'test-400', time: new Date().toISOString(), timeEpoch: Date.now(),
      },
    }));
    expect(result.statusCode).toBe(400);
  });

  it('should handle error responses', async () => {
    const app = createApp();
    app.get('/error', () => { throw new Error('boom'); });

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({ rawPath: '/error' }));
    expect(result.statusCode).toBe(500);
  });

  it('should handle CORS with plugin', async () => {
    const app = createApp();
    await app.register(cors({ origin: '*' }));
    app.get('/api', (_req, reply) => reply.json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({
      rawPath: '/api',
      headers: { host: 'api.example.com', origin: 'http://example.com' },
    }));
    expect(result.statusCode).toBe(200);
    expect(result.headers?.['access-control-allow-origin']).toBe('*');
  });

  it('should handle CORS preflight (OPTIONS)', async () => {
    const app = createApp();
    await app.register(cors({ origin: '*' }));
    app.get('/api', (_req, reply) => reply.json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({
      rawPath: '/api',
      method: 'OPTIONS',
      headers: { host: 'api.example.com', origin: 'http://example.com', 'access-control-request-method': 'GET' },
      requestContext: {
        http: { method: 'OPTIONS', path: '/api', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
        requestId: 'test-preflight', time: new Date().toISOString(), timeEpoch: Date.now(),
      },
    }));
    expect(result.statusCode).toBe(204);
    expect(result.headers?.['access-control-allow-origin']).toBe('*');
    expect(result.headers?.['access-control-allow-methods']).toBeTruthy();
  });

  it('should extract Set-Cookie to cookies array', async () => {
    const app = createApp();
    app.get('/cookie', (_req, reply) => {
      return reply.cookie('session', 'abc123', { httpOnly: true }).json({ ok: true });
    });

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({ rawPath: '/cookie' }));
    expect(result.statusCode).toBe(200);
    expect(result.cookies).toBeDefined();
    expect(result.cookies!.length).toBeGreaterThan(0);
    expect(result.cookies![0]).toContain('session=abc123');
  });
});
