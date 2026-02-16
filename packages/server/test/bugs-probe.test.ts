// @celsian/server — Bug-Finding Probe Tests
// Tests edge cases that might reveal bugs or missing features.

import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { Router } from '../src/router.js';

function makeRequest(url: string, method = 'GET'): Request {
  return new Request(`http://localhost${url}`, { method });
}

describe('Bug Probe: HEAD on GET route', () => {
  it('should auto-respond to HEAD for GET routes (RFC 9110 §9.3.2)', async () => {
    const app = createApp();
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    const response = await app.handle(makeRequest('/test', 'HEAD'));
    expect(response.status).toBe(200);
    // HEAD responses must have no body
    const body = await response.text();
    expect(body).toBe('');
  });
});

describe('Bug Probe: Trailing slash handling', () => {
  it('should treat trailing slash as equivalent (splitPath filters empty segments)', async () => {
    const app = createApp();
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    const withSlash = await app.handle(makeRequest('/test/'));
    const withoutSlash = await app.handle(makeRequest('/test'));

    expect(withoutSlash.status).toBe(200);
    // The router uses split('/').filter(Boolean), so trailing slashes
    // are normalized away. Both /test and /test/ match.
    // FINDING: Trailing slash normalization works correctly.
    expect(withSlash.status).toBe(200);
  });
});

describe('Bug Probe: Double slash in path', () => {
  it('should handle double slashes (empty segments filtered out)', async () => {
    const app = createApp();
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    // /test and //test both produce ['test'] after split+filter
    const response = await app.handle(makeRequest('//test'));
    expect(response.status).toBe(200);
  });
});

describe('Bug Probe: Router method isolation', () => {
  it('should return 404 when correct path exists but wrong method', async () => {
    const router = new Router();
    router.addRoute('POST', '/data', (() => {}) as any);

    expect(router.match('GET', '/data')).toBeNull();
    expect(router.match('POST', '/data')).not.toBeNull();
  });
});

describe('Bug Probe: Empty route path', () => {
  it('should handle root path /', async () => {
    const app = createApp();
    app.get('/', (req, reply) => reply.json({ root: true }));

    const response = await app.handle(makeRequest('/'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ root: true });
  });
});

describe('Bug Probe: Plugin hooks inheritance depth', () => {
  it('should inherit root hooks in deeply nested plugins', async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook('onRequest', async () => { order.push('root'); });

    const level2: any = async (app: any) => {
      app.addHook('onRequest', async () => { order.push('level2'); });
      app.get('/deep', (req: any, reply: any) => reply.json({ ok: true }));
    };

    const level1: any = async (app: any) => {
      app.addHook('onRequest', async () => { order.push('level1'); });
      await app.register(level2, { prefix: '/l2' });
    };

    await app.register(level1, { prefix: '/l1' });

    const response = await app.handle(makeRequest('/l1/l2/deep'));
    expect(response.status).toBe(200);
    // Root hook should be inherited by all levels
    expect(order).toContain('root');
    expect(order).toContain('level1');
    expect(order).toContain('level2');
    expect(order).toEqual(['root', 'level1', 'level2']);
  });
});

describe('Bug Probe: Reply header case normalization', () => {
  it('should normalize header keys to lowercase', async () => {
    const app = createApp();
    app.get('/headers', (req, reply) => {
      return reply
        .header('X-Custom-Header', 'value1')
        .header('Content-Type', 'text/special')
        .send('ok');
    });

    const response = await app.handle(makeRequest('/headers'));
    // reply.header() lowercases keys
    expect(response.headers.get('x-custom-header')).toBe('value1');
    // Note: content-type will be overridden by send()'s default
    // The spread in send() means reply headers override defaults
    expect(response.headers.get('content-type')).toBe('text/special');
  });
});

describe('Bug Probe: Request decoration collision', () => {
  it('should not overwrite existing request properties with decorations', async () => {
    const app = createApp();

    // Try to decorate with a name that conflicts with an existing property
    app.decorateRequest('method', 'SHOULD_NOT_OVERRIDE');
    app.decorateRequest('url', 'SHOULD_NOT_OVERRIDE');

    app.get('/collision', (req, reply) => {
      return reply.json({
        method: req.method,
        // url is on the Request prototype, so it exists
      });
    });

    const response = await app.handle(makeRequest('/collision'));
    const data = await response.json();
    // The decoration should NOT override existing properties (checked in app.ts: if (!(key in thenRequest)))
    expect(data.method).toBe('GET');
  });
});

describe('Bug Probe: Wildcard with no name', () => {
  it('should use "wild" as default wildcard param name when * has no suffix', async () => {
    const router = new Router();
    router.addRoute('GET', '/catch/*', (() => {}) as any);

    const match = router.match('GET', '/catch/anything/here');
    expect(match).not.toBeNull();
    // When wildcard is just *, the name defaults to 'wild'
    expect(match!.params.wild).toBe('anything/here');
  });
});

describe('Bug Probe: preSerialization and onSend hooks run after handler', () => {
  it('should run preSerialization hook after handler returns', async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook('preSerialization', async () => {
      order.push('preSerialization');
    });

    app.addHook('onSend', async () => {
      order.push('onSend');
    });

    app.get('/test', (req, reply) => {
      order.push('handler');
      return reply.json({ ok: true });
    });

    await app.handle(makeRequest('/test'));
    expect(order).toEqual(['handler', 'preSerialization', 'onSend']);
  });
});

describe('Bug Probe: onResponse hook error swallowing', () => {
  it('should swallow errors in onResponse hooks (fire-and-forget)', async () => {
    const app = createApp();

    app.addHook('onResponse', () => {
      throw new Error('onResponse error should be swallowed');
    });

    app.get('/test', (req, reply) => reply.json({ ok: true }));

    // Should not throw
    const response = await app.handle(makeRequest('/test'));
    expect(response.status).toBe(200);
  });
});

describe('Bug Probe: Concurrent plugin registration', () => {
  it('should handle plugins registered in sequence (not truly concurrent)', async () => {
    const app = createApp();

    const plugins = Array.from({ length: 10 }, (_, i) => {
      const plugin: any = async (app: any) => {
        app.get(`/route-${i}`, (req: any, reply: any) => reply.json({ i }));
      };
      return app.register(plugin, { prefix: `/p${i}` });
    });

    // All registrations are awaited
    await Promise.all(plugins);

    // All 10 plugin routes should work
    for (let i = 0; i < 10; i++) {
      const response = await app.handle(makeRequest(`/p${i}/route-${i}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ i });
    }
  });
});
