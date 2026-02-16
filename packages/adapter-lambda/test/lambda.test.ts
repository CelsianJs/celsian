import { describe, it, expect } from 'vitest';
import { createApp } from '@celsian/core';
import { createLambdaHandler, type APIGatewayProxyEventV2 } from '../src/index.js';

function createEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: overrides.rawPath ?? '/hello',
    rawQueryString: overrides.rawQueryString ?? '',
    headers: overrides.headers ?? { host: 'api.example.com' },
    body: overrides.body,
    isBase64Encoded: overrides.isBase64Encoded ?? false,
    requestContext: overrides.requestContext ?? {
      http: {
        method: 'GET',
        path: '/hello',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'test-request-id',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    ...overrides,
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
    expect(result.body).toBeDefined();
    const body = JSON.parse(result.body!);
    expect(body).toEqual({ message: 'hello' });
  });

  it('should handle POST with JSON body', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ received: req.parsedBody }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({
      rawPath: '/data',
      headers: {
        host: 'api.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'test' }),
      requestContext: {
        http: {
          method: 'POST',
          path: '/data',
          protocol: 'HTTP/1.1',
          sourceIp: '127.0.0.1',
          userAgent: 'test',
        },
        requestId: 'test-2',
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
      },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toEqual({ received: { name: 'test' } });
  });

  it('should return 404 for unmatched routes', async () => {
    const app = createApp();
    const handler = createLambdaHandler(app);

    const result = await handler(createEvent({ rawPath: '/nope' }));
    expect(result.statusCode).toBe(404);
  });

  it('should include response headers', async () => {
    const app = createApp();
    app.get('/hello', (_req, reply) => {
      return reply.header('x-custom', 'value').json({ ok: true });
    });

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
      headers: {
        host: 'api.example.com',
        'content-type': 'application/json',
      },
      body: Buffer.from(body).toString('base64'),
      isBase64Encoded: true,
      requestContext: {
        http: {
          method: 'POST',
          path: '/data',
          protocol: 'HTTP/1.1',
          sourceIp: '127.0.0.1',
          userAgent: 'test',
        },
        requestId: 'test-3',
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
      },
    }));

    expect(result.statusCode).toBe(200);
    const responseBody = JSON.parse(result.body!);
    expect(responseBody).toEqual({ received: { encoded: true } });
  });

  it('should handle query string parameters', async () => {
    const app = createApp();
    app.get('/search', (req, reply) => reply.json({ q: req.query.q }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({
      rawPath: '/search',
      rawQueryString: 'q=hello',
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toEqual({ q: 'hello' });
  });
});
