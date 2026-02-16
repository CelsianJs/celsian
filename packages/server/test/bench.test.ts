// @celsian/server — Performance Micro-benchmarks
// Measures router matching, request handling throughput, and hook execution overhead.

import { describe, it, expect } from 'vitest';
import { Router } from '../src/router.js';
import { createApp } from '../src/app.js';

function makeRequest(url: string, method = 'GET'): Request {
  return new Request(`http://localhost${url}`, { method });
}

function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

// ─── Router Matching Performance ───

describe('Bench: Router Matching', () => {
  it('should measure matching performance across 1000 static routes', () => {
    const router = new Router();

    // Register 1000 routes
    for (let i = 0; i < 1000; i++) {
      router.addRoute('GET', `/route-${i}`, (() => {}) as any);
    }

    const iterations = 10000;
    const timings: number[] = [];

    // Warm up
    for (let i = 0; i < 100; i++) {
      router.match('GET', `/route-${i % 1000}`);
    }

    // Measure
    for (let i = 0; i < iterations; i++) {
      const path = `/route-${i % 1000}`;
      const start = performance.now();
      const match = router.match('GET', path);
      const end = performance.now();
      timings.push(end - start);
      expect(match).not.toBeNull();
    }

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p99 = percentile(timings, 99);
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;

    console.log(`[Router 1000 static routes] Iterations: ${iterations}`);
    console.log(`  avg: ${(avg * 1000).toFixed(2)} us`);
    console.log(`  p50: ${(p50 * 1000).toFixed(2)} us`);
    console.log(`  p99: ${(p99 * 1000).toFixed(2)} us`);

    // Sanity check: each lookup should be < 1ms on average
    expect(avg).toBeLessThan(1);
  });

  it('should measure matching performance with parametric routes', () => {
    const router = new Router();

    // Register 500 parametric routes
    for (let i = 0; i < 500; i++) {
      router.addRoute('GET', `/api/v${i}/:resource/:id`, (() => {}) as any);
    }

    const iterations = 10000;
    const timings: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const path = `/api/v${i % 500}/users/42`;
      const start = performance.now();
      const match = router.match('GET', path);
      const end = performance.now();
      timings.push(end - start);
      expect(match).not.toBeNull();
    }

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p99 = percentile(timings, 99);
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;

    console.log(`[Router 500 parametric routes] Iterations: ${iterations}`);
    console.log(`  avg: ${(avg * 1000).toFixed(2)} us`);
    console.log(`  p50: ${(p50 * 1000).toFixed(2)} us`);
    console.log(`  p99: ${(p99 * 1000).toFixed(2)} us`);

    expect(avg).toBeLessThan(1);
  });

  it('should measure worst-case matching (wildcard fallback)', () => {
    const router = new Router();

    // Static routes that won't match
    for (let i = 0; i < 100; i++) {
      router.addRoute('GET', `/exact/${i}`, (() => {}) as any);
    }
    // Parametric route
    router.addRoute('GET', `/fallback/:category`, (() => {}) as any);
    // Wildcard catch-all
    router.addRoute('GET', `/fallback/*rest`, (() => {}) as any);

    const iterations = 10000;
    const timings: number[] = [];

    for (let i = 0; i < iterations; i++) {
      // This will miss static, miss parametric (multiple segments), and hit wildcard
      const start = performance.now();
      const match = router.match('GET', `/fallback/a/b/c/d`);
      const end = performance.now();
      timings.push(end - start);
      expect(match).not.toBeNull();
    }

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p99 = percentile(timings, 99);
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;

    console.log(`[Router wildcard fallback] Iterations: ${iterations}`);
    console.log(`  avg: ${(avg * 1000).toFixed(2)} us`);
    console.log(`  p50: ${(p50 * 1000).toFixed(2)} us`);
    console.log(`  p99: ${(p99 * 1000).toFixed(2)} us`);

    expect(avg).toBeLessThan(1);
  });
});

// ─── Request Handling Throughput ───

describe('Bench: Request Handling Throughput', () => {
  it('should measure req/sec through createApp -> handle (no hooks)', async () => {
    const app = createApp();
    app.get('/bench', (req, reply) => reply.json({ ok: true }));

    const request = makeRequest('/bench');
    const iterations = 5000;

    // Warm up
    for (let i = 0; i < 50; i++) {
      await app.handle(request);
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await app.handle(makeRequest('/bench'));
    }
    const elapsed = performance.now() - start;

    const reqPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[CelsianApp handle() throughput, no hooks]`);
    console.log(`  ${iterations} requests in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${reqPerSec} req/sec`);

    // Should be able to do at least 1000 req/sec in-process
    expect(reqPerSec).toBeGreaterThan(1000);
  });

  it('should measure req/sec with hooks (onRequest + preHandler)', async () => {
    const app = createApp();
    app.addHook('onRequest', async () => {});
    app.addHook('preHandler', async () => {});
    app.get('/bench', (req, reply) => reply.json({ ok: true }));

    const iterations = 5000;

    // Warm up
    for (let i = 0; i < 50; i++) {
      await app.handle(makeRequest('/bench'));
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await app.handle(makeRequest('/bench'));
    }
    const elapsed = performance.now() - start;

    const reqPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[CelsianApp handle() throughput, with hooks]`);
    console.log(`  ${iterations} requests in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${reqPerSec} req/sec`);

    expect(reqPerSec).toBeGreaterThan(500);
  });

  it('should measure parametric route handling throughput', async () => {
    const app = createApp();
    app.get('/users/:id/posts/:postId', (req, reply) => {
      return reply.json({ userId: req.params.id, postId: req.params.postId });
    });

    const iterations = 5000;

    // Warm up
    for (let i = 0; i < 50; i++) {
      await app.handle(makeRequest('/users/1/posts/2'));
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await app.handle(makeRequest(`/users/${i % 100}/posts/${i % 50}`));
    }
    const elapsed = performance.now() - start;

    const reqPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[CelsianApp parametric route throughput]`);
    console.log(`  ${iterations} requests in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${reqPerSec} req/sec`);

    expect(reqPerSec).toBeGreaterThan(500);
  });

  it('should measure JSON body parsing throughput', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => {
      return reply.json({ received: true });
    });

    const body = { name: 'Alice', age: 30, tags: ['a', 'b', 'c'] };
    const iterations = 2000;

    // Warm up
    for (let i = 0; i < 20; i++) {
      await app.handle(
        new Request('http://localhost/data', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await app.handle(
        new Request('http://localhost/data', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    }
    const elapsed = performance.now() - start;

    const reqPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[CelsianApp POST JSON body parsing throughput]`);
    console.log(`  ${iterations} requests in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${reqPerSec} req/sec`);

    expect(reqPerSec).toBeGreaterThan(500);
  });
});

// ─── Route Registration Performance ───

describe('Bench: Route Registration', () => {
  it('should measure time to register 1000 routes', () => {
    const start = performance.now();
    const app = createApp();

    for (let i = 0; i < 1000; i++) {
      app.get(`/route-${i}`, (req, reply) => reply.json({ i }));
    }

    const elapsed = performance.now() - start;
    console.log(`[Route registration] 1000 routes in ${elapsed.toFixed(2)} ms`);

    // Should be < 100ms to register 1000 routes
    expect(elapsed).toBeLessThan(100);
  });

  it('should list routes efficiently after bulk registration', () => {
    const app = createApp();
    for (let i = 0; i < 1000; i++) {
      app.get(`/route-${i}`, (req, reply) => reply.json({}));
    }

    const start = performance.now();
    const routes = app.getRoutes();
    const elapsed = performance.now() - start;

    console.log(`[getRoutes()] 1000 routes listed in ${elapsed.toFixed(2)} ms`);
    expect(routes.length).toBe(1000);
    expect(elapsed).toBeLessThan(50);
  });
});
