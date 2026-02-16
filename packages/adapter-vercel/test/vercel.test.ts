import { describe, it, expect } from 'vitest';
import { createApp } from '@celsian/core';
import { createVercelEdgeHandler } from '../src/index.js';

describe('@celsian/adapter-vercel', () => {
  it('should create an edge handler from app.fetch', () => {
    const app = createApp();
    app.get('/hello', (_req, reply) => reply.json({ message: 'hello' }));

    const handler = createVercelEdgeHandler(app);
    expect(typeof handler).toBe('function');
  });

  it('should handle edge requests', async () => {
    const app = createApp();
    app.get('/hello', (_req, reply) => reply.json({ message: 'hello' }));

    const handler = createVercelEdgeHandler(app);
    const response = await handler(new Request('http://localhost/hello'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ message: 'hello' });
  });

  it('should return 404 for unmatched routes', async () => {
    const app = createApp();
    const handler = createVercelEdgeHandler(app);

    const response = await handler(new Request('http://localhost/nope'));
    expect(response.status).toBe(404);
  });

  it('should handle POST requests with body', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ received: req.parsedBody }));

    const handler = createVercelEdgeHandler(app);
    const response = await handler(
      new Request('http://localhost/data', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ received: { name: 'test' } });
  });
});
