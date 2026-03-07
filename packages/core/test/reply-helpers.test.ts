import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('Reply Status Code Helpers', () => {
  it('reply.notFound()', async () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.notFound('User not found'));
    const res = await app.inject({ url: '/test' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'User not found', statusCode: 404, code: 'NOT_FOUND' });
  });

  it('reply.notFound() with default message', async () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.notFound());
    const res = await app.inject({ url: '/test' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found', statusCode: 404, code: 'NOT_FOUND' });
  });

  it('reply.badRequest()', async () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.badRequest('Invalid input'));
    const res = await app.inject({ url: '/test' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid input', statusCode: 400, code: 'BAD_REQUEST' });
  });

  it('reply.unauthorized()', async () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.unauthorized());
    const res = await app.inject({ url: '/test' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized', statusCode: 401, code: 'UNAUTHORIZED' });
  });

  it('reply.forbidden()', async () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.forbidden());
    const res = await app.inject({ url: '/test' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden', statusCode: 403, code: 'FORBIDDEN' });
  });

  it('reply.conflict()', async () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.conflict('Already exists'));
    const res = await app.inject({ url: '/test' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Already exists', statusCode: 409, code: 'CONFLICT' });
  });

  it('reply.gone()', async () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.gone());
    const res = await app.inject({ url: '/test' });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'Gone', statusCode: 410, code: 'GONE' });
  });

  it('reply.tooManyRequests()', async () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.tooManyRequests());
    const res = await app.inject({ url: '/test' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too Many Requests', statusCode: 429, code: 'TOO_MANY_REQUESTS' });
  });

  it('reply.internalServerError()', async () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.internalServerError());
    const res = await app.inject({ url: '/test' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal Server Error', statusCode: 500, code: 'INTERNAL_SERVER_ERROR' });
  });

  it('reply.serviceUnavailable()', async () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.serviceUnavailable('Maintenance'));
    const res = await app.inject({ url: '/test' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Maintenance', statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  });
});
