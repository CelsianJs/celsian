import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('Route Manifest & Filtering', () => {
  it('should filter routes by kind', () => {
    const app = createApp();
    app.get('/api/users', (_req, reply) => reply.json([]));
    app.route({ method: 'POST', url: '/api/process', handler: (_req, reply) => reply.json({}), kind: 'hot' });
    app.route({ method: 'POST', url: '/tasks/email', handler: (_req, reply) => reply.json({}), kind: 'task' });

    const serverless = app.getRoutes({ kind: 'serverless' });
    expect(serverless).toHaveLength(1);
    expect(serverless[0].url).toBe('/api/users');

    const hot = app.getRoutes({ kind: 'hot' });
    expect(hot).toHaveLength(1);
    expect(hot[0].url).toBe('/api/process');

    const tasks = app.getRoutes({ kind: 'task' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].url).toBe('/tasks/email');
  });

  it('should return all routes without filter', () => {
    const app = createApp();
    app.get('/a', (_req, reply) => reply.json({}));
    app.route({ method: 'GET', url: '/b', handler: (_req, reply) => reply.json({}), kind: 'hot' });

    expect(app.getRoutes()).toHaveLength(2);
  });

  it('should generate route manifest grouped by kind', () => {
    const app = createApp();
    app.get('/api/users', (_req, reply) => reply.json([]));
    app.post('/api/users', (_req, reply) => reply.json({}));
    app.route({ method: 'POST', url: '/process', handler: (_req, reply) => reply.json({}), kind: 'hot' });
    app.route({ method: 'POST', url: '/tasks/notify', handler: (_req, reply) => reply.json({}), kind: 'task' });

    const manifest = app.getRouteManifest();
    expect(manifest.serverless).toHaveLength(2);
    expect(manifest.hot).toHaveLength(1);
    expect(manifest.task).toHaveLength(1);
    expect(manifest.serverless[0]).toEqual({ method: 'GET', url: '/api/users', kind: 'serverless' });
    expect(manifest.hot[0]).toEqual({ method: 'POST', url: '/process', kind: 'hot' });
  });

  it('should default routes to serverless kind', () => {
    const app = createApp();
    app.get('/test', (_req, reply) => reply.json({}));

    const manifest = app.getRouteManifest();
    expect(manifest.serverless).toHaveLength(1);
    expect(manifest.hot).toHaveLength(0);
    expect(manifest.task).toHaveLength(0);
  });
});
