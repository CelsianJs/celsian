// @celsian/server — Tests for middleware plugins

import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { cors } from '../src/middleware/cors.js';
import { rateLimit, MemoryStore } from '../src/middleware/rate-limit.js';
import { jwtAuth } from '../src/middleware/jwt-auth.js';
import { withETag } from '../src/middleware/etag.js';
import type { CelsianRequest, CelsianReply } from '../src/types.js';

function makeRequest(
  url: string,
  method = 'GET',
  headers?: Record<string, string>,
  body?: unknown,
): Request {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  return new Request(`http://localhost${url}`, init);
}

// ─── CORS ───

describe('cors middleware', () => {
  it('adds Access-Control-Allow-Origin: * by default', async () => {
    const app = createApp();
    await app.register(cors);
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    const response = await app.handle(makeRequest('/test', 'GET', { origin: 'https://example.com' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('handles preflight OPTIONS requests', async () => {
    const app = createApp();
    await app.register(cors);
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    const response = await app.handle(makeRequest('/test', 'OPTIONS', {
      origin: 'https://example.com',
      'access-control-request-method': 'POST',
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('respects specific origin configuration', async () => {
    const app = createApp();
    await app.register(cors, { origin: 'https://allowed.com' });
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    // Allowed origin
    const allowed = await app.handle(makeRequest('/test', 'GET', { origin: 'https://allowed.com' }));
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://allowed.com');

    // Disallowed origin
    const denied = await app.handle(makeRequest('/test', 'GET', { origin: 'https://evil.com' }));
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('supports array of origins', async () => {
    const app = createApp();
    await app.register(cors, { origin: ['https://a.com', 'https://b.com'] });
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    const res1 = await app.handle(makeRequest('/test', 'GET', { origin: 'https://a.com' }));
    expect(res1.headers.get('access-control-allow-origin')).toBe('https://a.com');

    const res2 = await app.handle(makeRequest('/test', 'GET', { origin: 'https://c.com' }));
    expect(res2.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('supports regex origin', async () => {
    const app = createApp();
    await app.register(cors, { origin: /\.example\.com$/ });
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    const res = await app.handle(makeRequest('/test', 'GET', { origin: 'https://app.example.com' }));
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  });

  it('sets credentials header when configured', async () => {
    const app = createApp();
    await app.register(cors, { origin: 'https://app.com', credentials: true });
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    const res = await app.handle(makeRequest('/test', 'GET', { origin: 'https://app.com' }));
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.com');
  });

  it('mirrors Access-Control-Request-Headers in preflight', async () => {
    const app = createApp();
    await app.register(cors);
    app.post('/test', (req, reply) => reply.json({ ok: true }));

    const res = await app.handle(makeRequest('/test', 'OPTIONS', {
      origin: 'https://example.com',
      'access-control-request-headers': 'X-Custom-Header, Authorization',
    }));

    expect(res.headers.get('access-control-allow-headers')).toBe('X-Custom-Header, Authorization');
  });
});

// ─── Rate Limiting ───

describe('rateLimit middleware', () => {
  it('allows requests under the limit', async () => {
    const app = createApp();
    await app.register(rateLimit, { max: 5, windowMs: 60_000 });
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    const res = await app.handle(makeRequest('/test'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBe('5');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('4');
  });

  it('blocks requests over the limit with 429', async () => {
    const app = createApp();
    await app.register(rateLimit, { max: 3, windowMs: 60_000 });
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    // Make 3 allowed requests
    for (let i = 0; i < 3; i++) {
      const res = await app.handle(makeRequest('/test'));
      expect(res.status).toBe(200);
    }

    // 4th should be rate limited
    const blocked = await app.handle(makeRequest('/test'));
    expect(blocked.status).toBe(429);
    const data = await blocked.json();
    expect(data.error).toBe('Too Many Requests');
    expect(blocked.headers.get('retry-after')).toBeDefined();
  });

  it('uses custom key generator', async () => {
    const app = createApp();
    await app.register(rateLimit, {
      max: 2,
      windowMs: 60_000,
      keyGenerator: (req) => new URL(req.url).pathname,
    });
    app.get('/a', (req, reply) => reply.json({ route: 'a' }));
    app.get('/b', (req, reply) => reply.json({ route: 'b' }));

    // Route A: 2 requests OK
    await app.handle(makeRequest('/a'));
    await app.handle(makeRequest('/a'));
    const blockedA = await app.handle(makeRequest('/a'));
    expect(blockedA.status).toBe(429);

    // Route B should still work (different key)
    const resB = await app.handle(makeRequest('/b'));
    expect(resB.status).toBe(200);
  });

  it('includes rate limit headers', async () => {
    const app = createApp();
    await app.register(rateLimit, { max: 10, windowMs: 60_000 });
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    const res = await app.handle(makeRequest('/test'));
    expect(res.headers.get('x-ratelimit-limit')).toBe('10');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('9');
    expect(res.headers.get('x-ratelimit-reset')).toBeDefined();
  });
});

// ─── JWT Auth ───

describe('jwtAuth middleware', () => {
  it('rejects requests without token', async () => {
    const app = createApp();
    await app.register(jwtAuth, {
      verify: async () => ({ sub: 'test' }),
    });
    app.get('/protected', (req, reply) => reply.json({ secret: true }));

    const res = await app.handle(makeRequest('/protected'));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.message).toContain('Missing');
  });

  it('allows requests with valid token', async () => {
    const app = createApp();
    await app.register(jwtAuth, {
      verify: async (token) => {
        if (token === 'valid-token') return { sub: 'user-1' };
        return null;
      },
    });
    app.get('/protected', (req, reply) => {
      return reply.json({ user: (req as any).user });
    });

    const res = await app.handle(makeRequest('/protected', 'GET', {
      authorization: 'Bearer valid-token',
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.sub).toBe('user-1');
  });

  it('rejects requests with invalid token', async () => {
    const app = createApp();
    await app.register(jwtAuth, {
      verify: async () => null,
    });
    app.get('/protected', (req, reply) => reply.json({ secret: true }));

    const res = await app.handle(makeRequest('/protected', 'GET', {
      authorization: 'Bearer bad-token',
    }));
    expect(res.status).toBe(401);
  });

  it('excludes specified paths', async () => {
    const app = createApp();
    await app.register(jwtAuth, {
      verify: async () => null, // Always reject
      exclude: ['/api/health', '/api/auth/*'],
    });
    app.get('/api/health', (req, reply) => reply.json({ status: 'ok' }));
    app.get('/api/auth/login', (req, reply) => reply.json({ token: 'abc' }));
    app.get('/api/secret', (req, reply) => reply.json({ secret: true }));

    // Excluded paths should work without token
    const health = await app.handle(makeRequest('/api/health'));
    expect(health.status).toBe(200);

    const login = await app.handle(makeRequest('/api/auth/login'));
    expect(login.status).toBe(200);

    // Protected path should fail
    const secret = await app.handle(makeRequest('/api/secret'));
    expect(secret.status).toBe(401);
  });

  it('throws if neither secret nor verify provided', async () => {
    const app = createApp();
    await expect(
      app.register(jwtAuth, {}),
    ).rejects.toThrow('Either "secret" or "verify" option is required');
  });
});

// ─── ETag ───

describe('withETag helper', () => {
  it('returns 200 with ETag header for new requests', () => {
    const request = makeRequest('/data');
    const response = withETag(request, { hello: 'world' });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeDefined();
    expect(response.headers.get('etag')!.startsWith('W/"')).toBe(true);
  });

  it('returns 304 when If-None-Match matches', () => {
    const data = { hello: 'world' };

    // First request to get the ETag
    const firstResponse = withETag(makeRequest('/data'), data);
    const etagValue = firstResponse.headers.get('etag')!;

    // Second request with If-None-Match
    const request = makeRequest('/data', 'GET', { 'if-none-match': etagValue });
    const response = withETag(request, data);

    expect(response.status).toBe(304);
  });

  it('returns 200 when content changes', () => {
    const request1 = makeRequest('/data');
    const res1 = withETag(request1, { version: 1 });
    const etag1 = res1.headers.get('etag')!;

    // Different data should produce different ETag
    const request2 = makeRequest('/data', 'GET', { 'if-none-match': etag1 });
    const res2 = withETag(request2, { version: 2 });

    expect(res2.status).toBe(200);
  });

  it('handles string data', () => {
    const response = withETag(makeRequest('/text'), 'Hello, World!');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('etag')).toBeDefined();
  });
});
