// @celsian/server — Integration Tests
// Tests the full server lifecycle, plugins, body parsing, error handling,
// decorators, wildcards, HTTP methods, large payloads, concurrency, and route priority.

import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import type { CelsianRequest, CelsianReply, PluginFunction, HookHandler } from '../src/types.js';

// ─── Helpers ───

function makeRequest(
  url: string,
  method = 'GET',
  options?: {
    body?: unknown;
    headers?: Record<string, string>;
    rawBody?: string;
  },
): Request {
  const init: RequestInit = { method };
  if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = {
      'content-type': 'application/json',
      ...options?.headers,
    };
  } else if (options?.rawBody !== undefined) {
    init.body = options.rawBody;
    init.headers = options?.headers ?? {};
  } else {
    init.headers = options?.headers ?? {};
  }
  return new Request(`http://localhost${url}`, init);
}

// ─── 1. Full Request Lifecycle ───

describe('Integration: Full Request Lifecycle', () => {
  it('should fire all hooks in correct order for a successful request', async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook('onRequest', async () => { order.push('onRequest'); });
    app.addHook('preParsing', async () => { order.push('preParsing'); });
    app.addHook('preValidation', async () => { order.push('preValidation'); });
    app.addHook('preHandler', async () => { order.push('preHandler'); });
    app.addHook('preSerialization', async () => { order.push('preSerialization'); });
    app.addHook('onSend', async () => { order.push('onSend'); });
    app.addHook('onResponse', async () => { order.push('onResponse'); });

    app.get('/lifecycle', (req, reply) => {
      order.push('handler');
      return reply.json({ ok: true });
    });

    const response = await app.handle(makeRequest('/lifecycle'));
    expect(response.status).toBe(200);

    // onResponse is fire-and-forget, but should have been invoked synchronously
    // Allow microtask to flush
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(order).toEqual([
      'onRequest',
      'preParsing',
      'preValidation',
      'preHandler',
      'handler',
      'preSerialization',
      'onSend',
      'onResponse',
    ]);
  });

  it('should short-circuit on early response from preParsing hook', async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook('onRequest', async () => { order.push('onRequest'); });
    app.addHook('preParsing', async (req, reply) => {
      order.push('preParsing');
      return reply.status(401).json({ error: 'Unauthorized' });
    });
    app.addHook('preValidation', async () => { order.push('preValidation'); });

    app.get('/guarded', (req, reply) => {
      order.push('handler');
      return reply.json({ ok: true });
    });

    const response = await app.handle(makeRequest('/guarded'));
    expect(response.status).toBe(401);
    expect(order).toEqual(['onRequest', 'preParsing']);
    expect(order).not.toContain('preValidation');
    expect(order).not.toContain('handler');
  });

  it('should short-circuit on early response from preValidation hook', async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook('preValidation', async (req, reply) => {
      order.push('preValidation');
      return reply.status(422).json({ error: 'Invalid' });
    });

    app.post('/validate', (req, reply) => {
      order.push('handler');
      return reply.json({ ok: true });
    });

    const response = await app.handle(makeRequest('/validate', 'POST', { body: { bad: true } }));
    expect(response.status).toBe(422);
    expect(order).toEqual(['preValidation']);
  });

  it('should run multiple hooks of the same type in registration order', async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook('onRequest', async () => { order.push('onRequest-1'); });
    app.addHook('onRequest', async () => { order.push('onRequest-2'); });
    app.addHook('onRequest', async () => { order.push('onRequest-3'); });

    app.get('/multi-hook', (req, reply) => reply.json({ ok: true }));

    await app.handle(makeRequest('/multi-hook'));
    expect(order).toEqual(['onRequest-1', 'onRequest-2', 'onRequest-3']);
  });
});

// ─── 2. Multiple Plugins with Prefix Isolation ───

describe('Integration: Plugin Prefix Isolation', () => {
  it('should isolate routes under different plugin prefixes', async () => {
    const app = createApp();

    const pluginV1: PluginFunction = async (app) => {
      app.get('/users', (req, reply) => reply.json({ version: 'v1', users: ['alice'] }));
    };

    const pluginV2: PluginFunction = async (app) => {
      app.get('/users', (req, reply) => reply.json({ version: 'v2', users: ['alice', 'bob'] }));
    };

    await app.register(pluginV1, { prefix: '/api/v1' });
    await app.register(pluginV2, { prefix: '/api/v2' });

    const r1 = await app.handle(makeRequest('/api/v1/users'));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ version: 'v1', users: ['alice'] });

    const r2 = await app.handle(makeRequest('/api/v2/users'));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ version: 'v2', users: ['alice', 'bob'] });
  });

  it('should isolate hooks between plugins', async () => {
    const app = createApp();
    const hookLog: string[] = [];

    app.addHook('onRequest', async () => { hookLog.push('root'); });

    const pluginA: PluginFunction = async (app) => {
      app.addHook('onRequest', async () => { hookLog.push('pluginA'); });
      app.get('/data', (req, reply) => reply.json({ plugin: 'A' }));
    };

    const pluginB: PluginFunction = async (app) => {
      app.addHook('onRequest', async () => { hookLog.push('pluginB'); });
      app.get('/data', (req, reply) => reply.json({ plugin: 'B' }));
    };

    await app.register(pluginA, { prefix: '/a' });
    await app.register(pluginB, { prefix: '/b' });

    // Hitting /a/data should see root + pluginA hooks, NOT pluginB
    hookLog.length = 0;
    await app.handle(makeRequest('/a/data'));
    expect(hookLog).toEqual(['root', 'pluginA']);

    // Hitting /b/data should see root + pluginB hooks, NOT pluginA
    hookLog.length = 0;
    await app.handle(makeRequest('/b/data'));
    expect(hookLog).toEqual(['root', 'pluginB']);
  });

  it('should support triple-nested plugins with correct prefix composition', async () => {
    const app = createApp();

    const innerPlugin: PluginFunction = async (app) => {
      app.get('/health', (req, reply) => reply.json({ level: 'inner' }));
    };

    const middlePlugin: PluginFunction = async (app) => {
      app.get('/status', (req, reply) => reply.json({ level: 'middle' }));
      await app.register(innerPlugin, { prefix: '/inner' });
    };

    const outerPlugin: PluginFunction = async (app) => {
      await app.register(middlePlugin, { prefix: '/middle' });
    };

    await app.register(outerPlugin, { prefix: '/outer' });

    const r1 = await app.handle(makeRequest('/outer/middle/status'));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ level: 'middle' });

    const r2 = await app.handle(makeRequest('/outer/middle/inner/health'));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ level: 'inner' });
  });
});

// ─── 3. Body Parsing for Different Content Types ───

describe('Integration: Body Parsing', () => {
  it('should parse application/json bodies', async () => {
    const app = createApp();
    app.post('/json', (req, reply) => {
      return reply.json({ received: req.parsedBody });
    });

    const response = await app.handle(makeRequest('/json', 'POST', { body: { name: 'Alice', age: 30 } }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ received: { name: 'Alice', age: 30 } });
  });

  it('should parse text/plain bodies', async () => {
    const app = createApp();
    app.post('/text', (req, reply) => {
      return reply.json({ received: req.parsedBody });
    });

    const response = await app.handle(makeRequest('/text', 'POST', {
      rawBody: 'Hello, world!',
      headers: { 'content-type': 'text/plain' },
    }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ received: 'Hello, world!' });
  });

  it('should parse text/html bodies', async () => {
    const app = createApp();
    app.post('/html', (req, reply) => {
      return reply.json({ received: req.parsedBody });
    });

    const response = await app.handle(makeRequest('/html', 'POST', {
      rawBody: '<p>Hello</p>',
      headers: { 'content-type': 'text/html' },
    }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ received: '<p>Hello</p>' });
  });

  it('should parse application/x-www-form-urlencoded bodies', async () => {
    const app = createApp();
    app.post('/form', (req, reply) => {
      const formData = req.parsedBody as FormData;
      const name = formData.get('name');
      return reply.json({ name });
    });

    const response = await app.handle(makeRequest('/form', 'POST', {
      rawBody: 'name=Alice&age=30',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ name: 'Alice' });
  });

  it('should leave parsedBody undefined for GET requests', async () => {
    const app = createApp();
    app.get('/no-body', (req, reply) => {
      return reply.json({ hasBody: req.parsedBody !== undefined });
    });

    const response = await app.handle(makeRequest('/no-body'));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ hasBody: false });
  });

  it('should handle malformed JSON gracefully', async () => {
    const app = createApp();
    app.post('/bad-json', (req, reply) => {
      return reply.json({ parsedBody: req.parsedBody ?? null });
    });

    const response = await app.handle(makeRequest('/bad-json', 'POST', {
      rawBody: '{invalid json',
      headers: { 'content-type': 'application/json' },
    }));
    // Body parsing failure leaves parsedBody as undefined
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ parsedBody: null });
  });
});

// ─── 4. Error Handling Chain ───

describe('Integration: Error Handling Chain', () => {
  it('should catch handler errors and pass to onError hook', async () => {
    const app = createApp();

    app.addHook('onError', async (error, req, reply) => {
      return reply.status(503).json({
        error: error.message,
        handled: true,
      });
    });

    app.get('/explode', () => {
      throw new Error('Boom!');
    });

    const response = await app.handle(makeRequest('/explode'));
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data).toEqual({ error: 'Boom!', handled: true });
  });

  it('should use default error response when no onError hook is registered', async () => {
    const app = createApp();

    app.get('/explode', () => {
      throw new Error('Unhandled boom');
    });

    const response = await app.handle(makeRequest('/explode'));
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data).toEqual({
      error: 'Unhandled boom',
      statusCode: 500,
    });
  });

  it('should use custom statusCode from error', async () => {
    const app = createApp();

    app.get('/not-found', () => {
      const err = new Error('Resource not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    });

    const response = await app.handle(makeRequest('/not-found'));
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.statusCode).toBe(404);
    expect(data.error).toBe('Resource not found');
  });

  it('should fallback to default error handler if onError hook throws', async () => {
    const app = createApp();

    app.addHook('onError', async () => {
      throw new Error('Error handler also failed');
    });

    app.get('/double-fail', () => {
      throw new Error('Original error');
    });

    const response = await app.handle(makeRequest('/double-fail'));
    // Should get default 500 response since onError hook itself threw
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('Original error');
    expect(data.statusCode).toBe(500);
  });

  it('should try multiple onError hooks and return the first Response', async () => {
    const app = createApp();
    const hooksCalled: string[] = [];

    app.addHook('onError', async (error, req, reply) => {
      hooksCalled.push('first');
      // Don't return a Response, so next hook is tried
    });

    app.addHook('onError', async (error, req, reply) => {
      hooksCalled.push('second');
      return reply.status(418).json({ error: 'Handled by second', teapot: true });
    });

    app.get('/multi-error', () => {
      throw new Error('Test');
    });

    const response = await app.handle(makeRequest('/multi-error'));
    expect(response.status).toBe(418);
    expect(hooksCalled).toEqual(['first', 'second']);
  });

  it('should catch async handler errors', async () => {
    const app = createApp();

    app.get('/async-fail', async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      throw new Error('Async failure');
    });

    const response = await app.handle(makeRequest('/async-fail'));
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('Async failure');
  });
});

// ─── 5. Decorators ───

describe('Integration: Decorators', () => {
  it('should apply request decorations to incoming requests', async () => {
    const app = createApp();

    app.decorateRequest('requestId', () => `req-${Date.now()}`);

    app.get('/decorated', (req, reply) => {
      return reply.json({
        hasRequestId: typeof (req as any).requestId === 'string',
        startsWithReq: ((req as any).requestId as string).startsWith('req-'),
      });
    });

    const response = await app.handle(makeRequest('/decorated'));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.hasRequestId).toBe(true);
    expect(data.startsWithReq).toBe(true);
  });

  it('should apply static request decorations', async () => {
    const app = createApp();

    app.decorateRequest('version', 'v1.0');

    app.get('/version', (req, reply) => {
      return reply.json({ version: (req as any).version });
    });

    const response = await app.handle(makeRequest('/version'));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.version).toBe('v1.0');
  });

  it('should support decorate() for app-level decorations', async () => {
    const app = createApp();
    app.decorate('db', { connected: true });

    // App-level decorations are stored in the context,
    // but are not directly on the request. They're available via the plugin context.
    // This test validates the decoration was set without error.
    app.get('/test', (req, reply) => reply.json({ ok: true }));

    const response = await app.handle(makeRequest('/test'));
    expect(response.status).toBe(200);
  });
});

// ─── 6. Wildcard Routes ───

describe('Integration: Wildcard Routes', () => {
  it('should match catch-all wildcard routes', async () => {
    const app = createApp();

    app.get('/files/*path', (req, reply) => {
      return reply.json({ path: req.params.path });
    });

    const r1 = await app.handle(makeRequest('/files/docs/readme.md'));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ path: 'docs/readme.md' });

    const r2 = await app.handle(makeRequest('/files/images/logo.png'));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ path: 'images/logo.png' });
  });

  it('should match deeply nested wildcard paths', async () => {
    const app = createApp();

    app.get('/static/*filepath', (req, reply) => {
      return reply.json({ filepath: req.params.filepath });
    });

    const response = await app.handle(makeRequest('/static/a/b/c/d/e/f.js'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ filepath: 'a/b/c/d/e/f.js' });
  });

  it('should match single-segment wildcard', async () => {
    const app = createApp();

    app.get('/catch/*all', (req, reply) => {
      return reply.json({ all: req.params.all });
    });

    const response = await app.handle(makeRequest('/catch/single'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ all: 'single' });
  });
});

// ─── 7. HEAD and OPTIONS Methods ───

describe('Integration: HEAD and OPTIONS Methods', () => {
  it('should handle HEAD requests', async () => {
    const app = createApp();

    app.route({
      method: 'HEAD',
      url: '/ping',
      handler: (req, reply) => {
        return reply.header('x-ping', 'pong').send(null);
      },
    });

    const response = await app.handle(makeRequest('/ping', 'HEAD'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ping')).toBe('pong');
  });

  it('should handle OPTIONS requests', async () => {
    const app = createApp();

    app.route({
      method: 'OPTIONS',
      url: '/cors',
      handler: (req, reply) => {
        return reply
          .header('Access-Control-Allow-Origin', '*')
          .header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
          .status(204)
          .send(null);
      },
    });

    const response = await app.handle(makeRequest('/cors', 'OPTIONS'));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE');
  });

  it('should support multiple methods on the same route via route()', async () => {
    const app = createApp();

    app.route({
      method: ['GET', 'POST'],
      url: '/multi',
      handler: (req, reply) => {
        return reply.json({ method: req.method });
      },
    });

    const r1 = await app.handle(makeRequest('/multi', 'GET'));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ method: 'GET' });

    const r2 = await app.handle(makeRequest('/multi', 'POST'));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ method: 'POST' });
  });
});

// ─── 8. Large Payloads ───

describe('Integration: Large Payloads', () => {
  it('should handle large JSON payloads', async () => {
    const app = createApp();

    app.post('/large', (req, reply) => {
      const body = req.parsedBody as { items: unknown[] };
      return reply.json({ count: body.items.length });
    });

    // Create a payload with 10,000 items
    const largePayload = {
      items: Array.from({ length: 10000 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
        description: `Description for item ${i} with some extra padding text to make it larger`,
      })),
    };

    const response = await app.handle(makeRequest('/large', 'POST', { body: largePayload }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.count).toBe(10000);
  });

  it('should handle large response bodies', async () => {
    const app = createApp();

    app.get('/large-response', (req, reply) => {
      const items = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
      return reply.json({ items });
    });

    const response = await app.handle(makeRequest('/large-response'));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.items.length).toBe(5000);
  });
});

// ─── 9. Concurrent Request Handling ───

describe('Integration: Concurrent Requests', () => {
  it('should handle many concurrent requests without interference', async () => {
    const app = createApp();

    app.get('/echo/:id', (req, reply) => {
      return reply.json({ id: req.params.id });
    });

    // Fire 100 concurrent requests
    const promises = Array.from({ length: 100 }, (_, i) =>
      app.handle(makeRequest(`/echo/${i}`)).then(async (r) => ({
        status: r.status,
        data: await r.json(),
      })),
    );

    const results = await Promise.all(promises);

    for (let i = 0; i < 100; i++) {
      expect(results[i]!.status).toBe(200);
      expect(results[i]!.data).toEqual({ id: String(i) });
    }
  });

  it('should isolate request state across concurrent requests', async () => {
    const app = createApp();

    app.post('/slow', async (req, reply) => {
      const body = req.parsedBody as { delay: number; value: string };
      // Simulate varying processing times
      await new Promise(resolve => setTimeout(resolve, body.delay));
      return reply.json({ value: body.value });
    });

    const promises = [
      app.handle(makeRequest('/slow', 'POST', { body: { delay: 30, value: 'slow' } })),
      app.handle(makeRequest('/slow', 'POST', { body: { delay: 1, value: 'fast' } })),
      app.handle(makeRequest('/slow', 'POST', { body: { delay: 15, value: 'medium' } })),
    ];

    const results = await Promise.all(promises);
    const data = await Promise.all(results.map(r => r.json()));

    expect(data[0]).toEqual({ value: 'slow' });
    expect(data[1]).toEqual({ value: 'fast' });
    expect(data[2]).toEqual({ value: 'medium' });
  });
});

// ─── 10. Route Priority: static > parametric > wildcard ───

describe('Integration: Route Priority', () => {
  it('should prefer static routes over parametric routes', async () => {
    const app = createApp();

    app.get('/users/me', (req, reply) => reply.json({ type: 'static' }));
    app.get('/users/:id', (req, reply) => reply.json({ type: 'parametric', id: req.params.id }));

    const r1 = await app.handle(makeRequest('/users/me'));
    expect(await r1.json()).toEqual({ type: 'static' });

    const r2 = await app.handle(makeRequest('/users/42'));
    expect(await r2.json()).toEqual({ type: 'parametric', id: '42' });
  });

  it('should prefer parametric routes over wildcard routes', async () => {
    const app = createApp();

    app.get('/files/:name', (req, reply) => reply.json({ type: 'parametric', name: req.params.name }));
    app.get('/files/*path', (req, reply) => reply.json({ type: 'wildcard', path: req.params.path }));

    const r1 = await app.handle(makeRequest('/files/readme.md'));
    expect(await r1.json()).toEqual({ type: 'parametric', name: 'readme.md' });

    const r2 = await app.handle(makeRequest('/files/docs/readme.md'));
    expect(await r2.json()).toEqual({ type: 'wildcard', path: 'docs/readme.md' });
  });

  it('should prefer static > parametric > wildcard (full priority chain)', async () => {
    const app = createApp();

    app.get('/api/users', (req, reply) => reply.json({ match: 'static' }));
    app.get('/api/:resource', (req, reply) => reply.json({ match: 'parametric', resource: req.params.resource }));
    app.get('/api/*path', (req, reply) => reply.json({ match: 'wildcard', path: req.params.path }));

    const r1 = await app.handle(makeRequest('/api/users'));
    expect(await r1.json()).toEqual({ match: 'static' });

    const r2 = await app.handle(makeRequest('/api/posts'));
    expect(await r2.json()).toEqual({ match: 'parametric', resource: 'posts' });

    const r3 = await app.handle(makeRequest('/api/posts/123/comments'));
    expect(await r3.json()).toEqual({ match: 'wildcard', path: 'posts/123/comments' });
  });
});

// ─── 11. Reply Helpers Edge Cases ───

describe('Integration: Reply Edge Cases', () => {
  it('should return 204 when handler returns void', async () => {
    const app = createApp();
    app.get('/void', () => {
      // Handler returns nothing
    });

    const response = await app.handle(makeRequest('/void'));
    expect(response.status).toBe(204);
  });

  it('should support returning raw Response from handler', async () => {
    const app = createApp();
    app.get('/raw', () => {
      return new Response('raw response', {
        status: 200,
        headers: { 'x-custom': 'raw' },
      });
    });

    const response = await app.handle(makeRequest('/raw'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-custom')).toBe('raw');
    expect(await response.text()).toBe('raw response');
  });

  it('should support reply.stream()', async () => {
    const app = createApp();
    app.get('/stream', (req, reply) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Hello'));
          controller.enqueue(new TextEncoder().encode(' Stream'));
          controller.close();
        },
      });
      return reply.stream(stream);
    });

    const response = await app.handle(makeRequest('/stream'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    const text = await response.text();
    expect(text).toBe('Hello Stream');
  });

  it('should support custom redirect status codes', async () => {
    const app = createApp();
    app.get('/moved', (req, reply) => {
      return reply.redirect('/new-location', 301);
    });

    const response = await app.handle(makeRequest('/moved'));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/new-location');
  });
});

// ─── 12. Route-Specific Hooks ───

describe('Integration: Route-Specific Hooks', () => {
  it('should run route-specific onRequest hooks', async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook('onRequest', async () => { order.push('global'); });

    app.route({
      method: 'GET',
      url: '/with-hook',
      onRequest: async () => { order.push('route-specific'); },
      handler: (req, reply) => {
        order.push('handler');
        return reply.json({ ok: true });
      },
    });

    app.get('/without-hook', (req, reply) => {
      return reply.json({ ok: true });
    });

    // Route with specific hook: should see global + route-specific
    order.length = 0;
    await app.handle(makeRequest('/with-hook'));
    expect(order).toEqual(['global', 'route-specific', 'handler']);

    // Route without specific hook: should only see global
    order.length = 0;
    await app.handle(makeRequest('/without-hook'));
    expect(order).not.toContain('route-specific');
  });

  it('should run route-specific preHandler hooks', async () => {
    const app = createApp();
    const order: string[] = [];

    app.route({
      method: 'GET',
      url: '/guarded',
      preHandler: async () => { order.push('preHandler'); },
      handler: (req, reply) => {
        order.push('handler');
        return reply.json({ ok: true });
      },
    });

    await app.handle(makeRequest('/guarded'));
    expect(order).toEqual(['preHandler', 'handler']);
  });
});

// ─── 13. DELETE, PUT, PATCH Methods ───

describe('Integration: All HTTP Methods', () => {
  it('should handle DELETE requests', async () => {
    const app = createApp();
    app.delete('/items/:id', (req, reply) => {
      return reply.status(200).json({ deleted: req.params.id });
    });

    const response = await app.handle(makeRequest('/items/42', 'DELETE'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: '42' });
  });

  it('should handle PUT requests', async () => {
    const app = createApp();
    app.put('/items/:id', (req, reply) => {
      return reply.json({ updated: req.params.id, body: req.parsedBody });
    });

    const response = await app.handle(makeRequest('/items/1', 'PUT', { body: { name: 'Updated' } }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.updated).toBe('1');
    expect(data.body).toEqual({ name: 'Updated' });
  });

  it('should handle PATCH requests', async () => {
    const app = createApp();
    app.patch('/items/:id', (req, reply) => {
      return reply.json({ patched: req.params.id });
    });

    const response = await app.handle(makeRequest('/items/1', 'PATCH', { body: { name: 'Patched' } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ patched: '1' });
  });
});
