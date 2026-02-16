// @celsian/server — Tests for Router

import { describe, it, expect } from 'vitest';
import { Router } from '../src/router.js';

describe('Router', () => {
  describe('static routes', () => {
    it('should match exact static routes', () => {
      const router = new Router();
      const handler = () => {};

      router.addRoute('GET', '/users', handler as any);
      router.addRoute('GET', '/posts', handler as any);

      const match = router.match('GET', '/users');
      expect(match).not.toBeNull();
      expect(match!.params).toEqual({});
    });

    it('should return null for non-matching routes', () => {
      const router = new Router();
      router.addRoute('GET', '/users', (() => {}) as any);

      expect(router.match('GET', '/posts')).toBeNull();
    });

    it('should match method-specific routes', () => {
      const router = new Router();
      const getHandler = () => {};
      const postHandler = () => {};

      router.addRoute('GET', '/users', getHandler as any);
      router.addRoute('POST', '/users', postHandler as any);

      const getMatch = router.match('GET', '/users');
      expect(getMatch).not.toBeNull();
      expect(getMatch!.handler).toBe(getHandler);

      const postMatch = router.match('POST', '/users');
      expect(postMatch).not.toBeNull();
      expect(postMatch!.handler).toBe(postHandler);
    });

    it('should not match wrong method', () => {
      const router = new Router();
      router.addRoute('GET', '/users', (() => {}) as any);

      expect(router.match('POST', '/users')).toBeNull();
    });
  });

  describe('parametric routes', () => {
    it('should match single parameter', () => {
      const router = new Router();
      router.addRoute('GET', '/users/:id', (() => {}) as any);

      const match = router.match('GET', '/users/42');
      expect(match).not.toBeNull();
      expect(match!.params).toEqual({ id: '42' });
    });

    it('should match multiple parameters', () => {
      const router = new Router();
      router.addRoute('GET', '/users/:userId/posts/:postId', (() => {}) as any);

      const match = router.match('GET', '/users/1/posts/5');
      expect(match).not.toBeNull();
      expect(match!.params).toEqual({ userId: '1', postId: '5' });
    });

    it('should prefer static over parametric', () => {
      const router = new Router();
      const staticHandler = () => {};
      const paramHandler = () => {};

      router.addRoute('GET', '/users/me', staticHandler as any);
      router.addRoute('GET', '/users/:id', paramHandler as any);

      const meMatch = router.match('GET', '/users/me');
      expect(meMatch).not.toBeNull();
      expect(meMatch!.handler).toBe(staticHandler);

      const idMatch = router.match('GET', '/users/42');
      expect(idMatch).not.toBeNull();
      expect(idMatch!.handler).toBe(paramHandler);
    });
  });

  describe('wildcard routes', () => {
    it('should match wildcard catch-all', () => {
      const router = new Router();
      router.addRoute('GET', '/files/*path', (() => {}) as any);

      const match = router.match('GET', '/files/docs/readme.md');
      expect(match).not.toBeNull();
      expect(match!.params).toEqual({ path: 'docs/readme.md' });
    });
  });

  describe('nested routes', () => {
    it('should handle deeply nested static routes', () => {
      const router = new Router();
      router.addRoute('GET', '/api/v1/users/settings/email', (() => {}) as any);

      const match = router.match('GET', '/api/v1/users/settings/email');
      expect(match).not.toBeNull();
    });
  });

  describe('getAllRoutes', () => {
    it('should return all registered routes', () => {
      const router = new Router();
      router.addRoute('GET', '/a', (() => {}) as any);
      router.addRoute('POST', '/b', (() => {}) as any);
      router.addRoute('GET', '/c/:id', (() => {}) as any);

      const routes = router.getAllRoutes();
      expect(routes.length).toBe(3);
    });
  });
});
