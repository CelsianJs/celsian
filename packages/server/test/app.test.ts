// @celsian/server — Tests for CelsianApp

import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import type { CelsianRequest, CelsianReply, PluginFunction } from '../src/types.js';

// ─── Helpers ───

function makeRequest(url: string, method = 'GET', body?: unknown): Request {
  const init: RequestInit = { method };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(`http://localhost${url}`, init);
}

// ─── Tests ───

describe('CelsianApp', () => {
  describe('routing', () => {
    it('should handle GET routes', async () => {
      const app = createApp();
      app.get('/hello', (req, reply) => reply.json({ message: 'Hello, world!' }));

      const response = await app.handle(makeRequest('/hello'));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({ message: 'Hello, world!' });
    });

    it('should handle POST routes', async () => {
      const app = createApp();
      app.post('/users', async (req, reply) => {
        return reply.status(201).json({ id: '1', name: 'Alice' });
      });

      const response = await app.handle(makeRequest('/users', 'POST', { name: 'Alice' }));
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data).toEqual({ id: '1', name: 'Alice' });
    });

    it('should return 404 for unknown routes', async () => {
      const app = createApp();
      app.get('/exists', (req, reply) => reply.json({ ok: true }));

      const response = await app.handle(makeRequest('/not-found'));
      expect(response.status).toBe(404);
    });

    it('should handle route parameters', async () => {
      const app = createApp();
      app.get('/users/:id', (req, reply) => {
        return reply.json({ id: req.params.id });
      });

      const response = await app.handle(makeRequest('/users/42'));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({ id: '42' });
    });

    it('should handle nested route parameters', async () => {
      const app = createApp();
      app.get('/users/:userId/posts/:postId', (req, reply) => {
        return reply.json({
          userId: req.params.userId,
          postId: req.params.postId,
        });
      });

      const response = await app.handle(makeRequest('/users/1/posts/5'));
      const data = await response.json();
      expect(data).toEqual({ userId: '1', postId: '5' });
    });

    it('should parse query parameters', async () => {
      const app = createApp();
      app.get('/search', (req, reply) => {
        return reply.json({ q: req.query.q, page: req.query.page });
      });

      const response = await app.handle(makeRequest('/search?q=hello&page=2'));
      const data = await response.json();
      expect(data).toEqual({ q: 'hello', page: '2' });
    });

    it('should support app prefix', async () => {
      const app = createApp({ prefix: '/api/v1' });
      app.get('/users', (req, reply) => reply.json({ users: [] }));

      const response = await app.handle(makeRequest('/api/v1/users'));
      expect(response.status).toBe(200);
    });
  });

  describe('hooks', () => {
    it('should run onRequest hooks', async () => {
      const app = createApp();
      const order: string[] = [];

      app.addHook('onRequest', async () => {
        order.push('onRequest');
      });

      app.get('/test', (req, reply) => {
        order.push('handler');
        return reply.json({ ok: true });
      });

      await app.handle(makeRequest('/test'));
      expect(order).toEqual(['onRequest', 'handler']);
    });

    it('should run hooks in order', async () => {
      const app = createApp();
      const order: string[] = [];

      app.addHook('onRequest', async () => { order.push('onRequest'); });
      app.addHook('preParsing', async () => { order.push('preParsing'); });
      app.addHook('preValidation', async () => { order.push('preValidation'); });
      app.addHook('preHandler', async () => { order.push('preHandler'); });
      app.addHook('onSend', async () => { order.push('onSend'); });

      app.get('/test', (req, reply) => {
        order.push('handler');
        return reply.json({ ok: true });
      });

      await app.handle(makeRequest('/test'));
      expect(order).toEqual([
        'onRequest',
        'preParsing',
        'preValidation',
        'preHandler',
        'handler',
        'onSend',
      ]);
    });

    it('should allow early response from hooks', async () => {
      const app = createApp();

      app.addHook('onRequest', async (req, reply) => {
        return reply.status(403).json({ error: 'Forbidden' });
      });

      app.get('/test', (req, reply) => {
        return reply.json({ should: 'not reach' });
      });

      const response = await app.handle(makeRequest('/test'));
      expect(response.status).toBe(403);

      const data = await response.json();
      expect(data).toEqual({ error: 'Forbidden' });
    });

    it('should handle errors with onError hook', async () => {
      const app = createApp();

      app.addHook('onError', async (error, req, reply) => {
        return reply.status(500).json({ error: error.message, custom: true });
      });

      app.get('/fail', () => {
        throw new Error('Something went wrong');
      });

      const response = await app.handle(makeRequest('/fail'));
      expect(response.status).toBe(500);

      const data = await response.json();
      expect(data).toEqual({ error: 'Something went wrong', custom: true });
    });
  });

  describe('plugins', () => {
    it('should register plugins', async () => {
      const app = createApp();

      const myPlugin: PluginFunction = async (app) => {
        app.get('/plugin-route', (req, reply) => {
          return reply.json({ from: 'plugin' });
        });
      };

      await app.register(myPlugin);

      const response = await app.handle(makeRequest('/plugin-route'));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({ from: 'plugin' });
    });

    it('should support plugin prefix', async () => {
      const app = createApp();

      const apiPlugin: PluginFunction = async (app) => {
        app.get('/users', (req, reply) => {
          return reply.json({ users: [] });
        });
      };

      await app.register(apiPlugin, { prefix: '/api' });

      const response = await app.handle(makeRequest('/api/users'));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({ users: [] });
    });

    it('should isolate plugin hooks (encapsulation)', async () => {
      const app = createApp();
      const hookOrder: string[] = [];

      // Root-level hook — applies to all routes
      app.addHook('onRequest', async () => {
        hookOrder.push('root');
      });

      // Plugin with its own hooks — should NOT leak to root
      const pluginA: PluginFunction = async (app) => {
        app.addHook('onRequest', async () => {
          hookOrder.push('pluginA');
        });
        app.get('/a', (req, reply) => reply.json({ route: 'a' }));
      };

      // Another plugin — should only see root hooks
      const pluginB: PluginFunction = async (app) => {
        app.get('/b', (req, reply) => reply.json({ route: 'b' }));
      };

      await app.register(pluginA, { prefix: '/api' });
      await app.register(pluginB, { prefix: '/other' });

      // Route in pluginA should see root + pluginA hooks
      hookOrder.length = 0;
      await app.handle(makeRequest('/api/a'));
      expect(hookOrder).toEqual(['root', 'pluginA']);

      // Route in pluginB should only see root hooks
      hookOrder.length = 0;
      await app.handle(makeRequest('/other/b'));
      expect(hookOrder).toEqual(['root']);
    });

    it('should support nested plugins', async () => {
      const app = createApp();

      const adminPlugin: PluginFunction = async (app) => {
        app.get('/dashboard', (req, reply) => reply.json({ page: 'dashboard' }));
      };

      const apiPlugin: PluginFunction = async (app) => {
        app.get('/health', (req, reply) => reply.json({ status: 'ok' }));
        await app.register(adminPlugin, { prefix: '/admin' });
      };

      await app.register(apiPlugin, { prefix: '/api' });

      // /api/health
      const r1 = await app.handle(makeRequest('/api/health'));
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({ status: 'ok' });

      // /api/admin/dashboard
      const r2 = await app.handle(makeRequest('/api/admin/dashboard'));
      expect(r2.status).toBe(200);
      expect(await r2.json()).toEqual({ page: 'dashboard' });
    });
  });

  describe('reply helpers', () => {
    it('should support reply.html()', async () => {
      const app = createApp();
      app.get('/', (req, reply) => {
        return reply.html('<h1>Hello</h1>');
      });

      const response = await app.handle(makeRequest('/'));
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await response.text()).toBe('<h1>Hello</h1>');
    });

    it('should support reply.redirect()', async () => {
      const app = createApp();
      app.get('/old', (req, reply) => {
        return reply.redirect('/new');
      });

      const response = await app.handle(makeRequest('/old'));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/new');
    });

    it('should support custom headers', async () => {
      const app = createApp();
      app.get('/custom', (req, reply) => {
        return reply
          .header('x-custom', 'value')
          .header('x-request-id', '123')
          .json({ ok: true });
      });

      const response = await app.handle(makeRequest('/custom'));
      expect(response.headers.get('x-custom')).toBe('value');
      expect(response.headers.get('x-request-id')).toBe('123');
    });
  });

  describe('body parsing', () => {
    it('should parse JSON bodies', async () => {
      const app = createApp();
      app.post('/echo', (req, reply) => {
        return reply.json({ received: req.parsedBody });
      });

      const response = await app.handle(makeRequest('/echo', 'POST', { hello: 'world' }));
      const data = await response.json();
      expect(data).toEqual({ received: { hello: 'world' } });
    });
  });

  describe('fetch handler', () => {
    it('should expose a fetch-compatible handler', async () => {
      const app = createApp();
      app.get('/test', (req, reply) => reply.json({ ok: true }));

      const handler = app.fetch;
      const response = await handler(makeRequest('/test'));
      expect(response.status).toBe(200);
    });
  });

  describe('route listing', () => {
    it('should list all registered routes', async () => {
      const app = createApp();
      app.get('/a', (req, reply) => reply.json({}));
      app.post('/b', (req, reply) => reply.json({}));
      app.get('/users/:id', (req, reply) => reply.json({}));

      const routes = app.getRoutes();
      expect(routes.length).toBe(3);
      expect(routes.map(r => `${r.method} ${r.url}`).sort()).toEqual([
        'GET /a',
        'GET /users/:id',
        'POST /b',
      ]);
    });
  });
});
