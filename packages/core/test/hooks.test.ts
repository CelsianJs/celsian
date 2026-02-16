import { describe, it, expect } from 'vitest';
import { createHookStore, cloneHookStore, runHooks, runHooksFireAndForget } from '../src/hooks.js';
import { createReply } from '../src/reply.js';
import { buildRequest } from '../src/request.js';

function makeRequest(url = 'http://localhost/test') {
  const request = new Request(url);
  return buildRequest(request, new URL(url), {});
}

describe('HookStore', () => {
  it('should create empty hook store', () => {
    const store = createHookStore();
    expect(store.onRequest).toEqual([]);
    expect(store.preHandler).toEqual([]);
    expect(store.onError).toEqual([]);
  });

  it('should clone hook store (shallow)', () => {
    const store = createHookStore();
    const handler = () => {};
    store.onRequest.push(handler as any);

    const clone = cloneHookStore(store);
    expect(clone.onRequest).toHaveLength(1);
    expect(clone.onRequest[0]).toBe(handler);

    // Modifying clone shouldn't affect original
    clone.onRequest.push((() => {}) as any);
    expect(store.onRequest).toHaveLength(1);
    expect(clone.onRequest).toHaveLength(2);
  });
});

describe('runHooks', () => {
  it('should run all hooks in order', async () => {
    const order: number[] = [];
    const hooks = [
      async () => { order.push(1); },
      async () => { order.push(2); },
      async () => { order.push(3); },
    ];

    const result = await runHooks(hooks as any[], makeRequest(), createReply());
    expect(result).toBeNull();
    expect(order).toEqual([1, 2, 3]);
  });

  it('should short-circuit on Response return', async () => {
    const order: number[] = [];
    const hooks = [
      async () => { order.push(1); },
      async () => {
        order.push(2);
        return new Response('early', { status: 401 });
      },
      async () => { order.push(3); },
    ];

    const result = await runHooks(hooks as any[], makeRequest(), createReply());
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
    expect(order).toEqual([1, 2]);
  });
});

describe('runHooksFireAndForget', () => {
  it('should not throw even if hooks fail', () => {
    const hooks = [
      () => { throw new Error('fail'); },
      () => {},
    ];

    expect(() => {
      runHooksFireAndForget(hooks as any[], makeRequest(), createReply());
    }).not.toThrow();
  });
});
