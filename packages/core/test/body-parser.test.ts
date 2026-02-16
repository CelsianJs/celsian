import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('Body Parsing Edge Cases', () => {
  it('should return 400 for malformed JSON', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ received: req.parsedBody }));

    // Use handle() directly to send raw malformed JSON
    const request = new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid json!!!',
    });

    const response = await app.handle(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INVALID_JSON');
    expect(body.error).toContain('Invalid JSON');
  });

  it('should handle empty JSON body gracefully', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ received: req.parsedBody ?? null }));

    const request = new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });

    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.received).toBeNull();
  });

  it('should parse text/plain bodies as text', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ received: req.parsedBody }));

    const request = new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'plain text data',
    });

    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.received).toBe('plain text data');
  });

  it('should handle text/html content type', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ received: req.parsedBody }));

    const request = new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'text/html' },
      body: '<p>Hello</p>',
    });

    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.received).toBe('<p>Hello</p>');
  });

  it('should not parse body for GET requests', async () => {
    const app = createApp();
    app.get('/data', (req, reply) => reply.json({ body: req.parsedBody ?? null }));

    const response = await app.inject({ url: '/data' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.body).toBeNull();
  });

  it('should include error code in 404 responses', async () => {
    const app = createApp();
    app.get('/exists', (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: '/nonexistent' });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Not Found');
    expect(body.statusCode).toBe(404);
  });
});
