import { describe, it, expect } from 'vitest';
import { Router } from '../src/router.js';

describe('Router', () => {
  it('should match static routes', () => {
    const router = new Router();
    const handler = () => {};
    router.addRoute('GET', '/health', handler as any);

    const match = router.match('GET', '/health');
    expect(match).not.toBeNull();
    expect(match!.handler).toBe(handler);
    expect(match!.params).toEqual({});
  });

  it('should match parameterized routes', () => {
    const router = new Router();
    const handler = () => {};
    router.addRoute('GET', '/users/:id', handler as any);

    const match = router.match('GET', '/users/123');
    expect(match).not.toBeNull();
    expect(match!.params).toEqual({ id: '123' });
  });

  it('should match nested parameterized routes', () => {
    const router = new Router();
    const handler = () => {};
    router.addRoute('GET', '/users/:userId/posts/:postId', handler as any);

    const match = router.match('GET', '/users/1/posts/42');
    expect(match).not.toBeNull();
    expect(match!.params).toEqual({ userId: '1', postId: '42' });
  });

  it('should match wildcard routes', () => {
    const router = new Router();
    const handler = () => {};
    router.addRoute('GET', '/files/*path', handler as any);

    const match = router.match('GET', '/files/images/photo.jpg');
    expect(match).not.toBeNull();
    expect(match!.params).toEqual({ path: 'images/photo.jpg' });
  });

  it('should prioritize static over param over wildcard', () => {
    const router = new Router();
    const staticHandler = () => 'static';
    const paramHandler = () => 'param';

    router.addRoute('GET', '/users/me', staticHandler as any);
    router.addRoute('GET', '/users/:id', paramHandler as any);

    const staticMatch = router.match('GET', '/users/me');
    expect(staticMatch!.handler).toBe(staticHandler);

    const paramMatch = router.match('GET', '/users/123');
    expect(paramMatch!.handler).toBe(paramHandler);
  });

  it('should return null for unmatched routes', () => {
    const router = new Router();
    router.addRoute('GET', '/health', (() => {}) as any);

    expect(router.match('GET', '/missing')).toBeNull();
    expect(router.match('POST', '/health')).toBeNull();
  });

  it('should separate routes by method', () => {
    const router = new Router();
    const getHandler = () => 'get';
    const postHandler = () => 'post';

    router.addRoute('GET', '/users', getHandler as any);
    router.addRoute('POST', '/users', postHandler as any);

    expect(router.match('GET', '/users')!.handler).toBe(getHandler);
    expect(router.match('POST', '/users')!.handler).toBe(postHandler);
  });

  it('should collect all routes', () => {
    const router = new Router();
    router.addRoute('GET', '/a', (() => {}) as any);
    router.addRoute('POST', '/b', (() => {}) as any);
    router.addRoute('GET', '/c/:id', (() => {}) as any);

    const routes = router.getAllRoutes();
    expect(routes).toHaveLength(3);
  });

  it('should handle root path', () => {
    const router = new Router();
    const handler = () => {};
    router.addRoute('GET', '/', handler as any);

    const match = router.match('GET', '/');
    expect(match).not.toBeNull();
    expect(match!.handler).toBe(handler);
  });

  // ─── BUG-11: URL-decoded params ───

  it('should URL-decode path parameters', () => {
    const router = new Router();
    const handler = () => {};
    router.addRoute('GET', '/files/:name', handler as any);

    const match = router.match('GET', '/files/hello%20world');
    expect(match).not.toBeNull();
    expect(match!.params).toEqual({ name: 'hello world' });
  });

  // ─── BUG-7: hasPath for 405 detection ───

  it('should detect path exists for different method (hasPath)', () => {
    const router = new Router();
    router.addRoute('GET', '/users', (() => {}) as any);

    expect(router.match('POST', '/users')).toBeNull();
    expect(router.hasPath('/users')).toBe(true);
    expect(router.hasPath('/missing')).toBe(false);
  });

  it('should detect parameterized paths exist', () => {
    const router = new Router();
    router.addRoute('GET', '/users/:id', (() => {}) as any);

    expect(router.hasPath('/users/42')).toBe(true);
    expect(router.hasPath('/nope/42')).toBe(false);
  });
});
