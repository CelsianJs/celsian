import { describe, it, expectTypeOf } from 'vitest';
import { createApp } from '../src/app.js';
import type { ExtractRouteParams, CelsianRequest } from '../src/types.js';

// ─── ExtractRouteParams utility type tests ───

describe('ExtractRouteParams', () => {
  it('should extract a single param', () => {
    expectTypeOf<ExtractRouteParams<'/users/:id'>>().toEqualTypeOf<{ id: string }>();
  });

  it('should extract multiple params', () => {
    expectTypeOf<ExtractRouteParams<'/users/:id/posts/:postId'>>().toEqualTypeOf<{ id: string; postId: string }>();
  });

  it('should extract wildcard param', () => {
    expectTypeOf<ExtractRouteParams<'/static/*'>>().toEqualTypeOf<{ '*': string }>();
  });

  it('should return empty object for no params', () => {
    expectTypeOf<ExtractRouteParams<'/no-params'>>().toEqualTypeOf<{}>();
  });

  it('should handle root path', () => {
    expectTypeOf<ExtractRouteParams<'/'>>().toEqualTypeOf<{}>();
  });

  it('should handle three params', () => {
    expectTypeOf<ExtractRouteParams<'/a/:x/b/:y/c/:z'>>().toEqualTypeOf<{ x: string; y: string; z: string }>();
  });

  it('should handle param at the start', () => {
    expectTypeOf<ExtractRouteParams<'/:id'>>().toEqualTypeOf<{ id: string }>();
  });
});

// ─── CelsianRequest generic param tests ───

describe('CelsianRequest generic params', () => {
  it('should default to Record<string, string>', () => {
    type DefaultReq = CelsianRequest;
    expectTypeOf<DefaultReq['params']>().toEqualTypeOf<Record<string, string>>();
  });

  it('should accept a custom params type', () => {
    type CustomReq = CelsianRequest<{ id: string }>;
    expectTypeOf<CustomReq['params']>().toEqualTypeOf<{ id: string }>();
  });
});

// ─── Route handler type inference tests ───

describe('Route handler type inference', () => {
  it('should infer single param from route string', () => {
    const app = createApp();
    app.get('/users/:id', (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ id: req.params.id });
    });
  });

  it('should infer multiple params from route string', () => {
    const app = createApp();
    app.get('/users/:id/posts/:postId', (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string; postId: string }>();
      return reply.json({ id: req.params.id, postId: req.params.postId });
    });
  });

  it('should infer wildcard param', () => {
    const app = createApp();
    app.get('/static/*', (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ '*': string }>();
      return reply.json({ path: req.params['*'] });
    });
  });

  it('should infer empty params for parameterless routes', () => {
    const app = createApp();
    app.get('/no-params', (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{}>();
      return reply.json({ ok: true });
    });
  });

  it('should work with POST routes', () => {
    const app = createApp();
    app.post('/users/:id', (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ id: req.params.id });
    });
  });

  it('should work with PUT routes', () => {
    const app = createApp();
    app.put('/users/:id', (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ id: req.params.id });
    });
  });

  it('should work with PATCH routes', () => {
    const app = createApp();
    app.patch('/users/:id', (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ id: req.params.id });
    });
  });

  it('should work with DELETE routes', () => {
    const app = createApp();
    app.delete('/users/:id', (req, reply) => {
      expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
      return reply.json({ id: req.params.id });
    });
  });

  it('should still allow accessing query and parsedBody', () => {
    const app = createApp();
    app.get('/users/:id', (req, reply) => {
      expectTypeOf(req.query).toEqualTypeOf<Record<string, string | string[]>>();
      expectTypeOf(req.parsedBody).toEqualTypeOf<unknown>();
      return reply.json({ ok: true });
    });
  });
});

// ─── Backwards compatibility tests ───

describe('Backwards compatibility', () => {
  it('should allow untyped CelsianRequest (default generic)', () => {
    // Simulate existing code that uses CelsianRequest without generics
    const handler = (req: CelsianRequest, reply: any) => {
      // With default generic, params is Record<string, string>
      // Any string key access should work
      const _id: string = req.params.anything;
      const _name: string = req.params.whatever;
    };
    expectTypeOf(handler).toBeFunction();
  });

  it('should work with plugin context route methods', async () => {
    const app = createApp();
    await app.register(async (ctx) => {
      ctx.get('/items/:itemId', (req, reply) => {
        expectTypeOf(req.params).toEqualTypeOf<{ itemId: string }>();
        return reply.json({ itemId: req.params.itemId });
      });
    });
  });
});
