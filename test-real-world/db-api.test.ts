import { describe, it, expect } from 'vitest';
import { buildDbApp } from './db-api.js';

describe('Database Analytics API', () => {
  // ─── Basic DB queries ───

  it('executes a single query and returns data', async () => {
    const { app } = buildDbApp();
    const res = await app.inject({ url: '/users' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toBeDefined();
    expect(body.rowCount).toBe(1);
  });

  it('executes multiple queries for dashboard', async () => {
    const { app, mockPool } = buildDbApp();
    const res = await app.inject({ url: '/dashboard' });
    expect(res.status).toBe(200);

    // Verify all 3 queries were executed
    expect(mockPool.queryLog).toContain('SELECT count(*) FROM users');
    expect(mockPool.queryLog).toContain('SELECT count(*) FROM orders');
    expect(mockPool.queryLog).toContain('SELECT sum(amount) FROM payments');
  });

  // ─── Server-Timing header ───

  it('adds Server-Timing header when DB queries are made', async () => {
    const { app } = buildDbApp();
    const res = await app.inject({ url: '/users' });
    const timing = res.headers.get('server-timing');
    expect(timing).toBeDefined();
    expect(timing).toMatch(/^db;dur=[\d.]+;desc="1 queries"$/);
  });

  it('Server-Timing reflects multiple queries', async () => {
    const { app } = buildDbApp();
    const res = await app.inject({ url: '/dashboard' });
    const timing = res.headers.get('server-timing');
    expect(timing).toBeDefined();
    expect(timing).toMatch(/desc="3 queries"/);
  });

  // ─── Metrics tracking ───

  it('tracked pool collects metrics per request', async () => {
    const { app, tracked } = buildDbApp();

    // First request
    await app.inject({ url: '/users' });
    // Metrics were reset at start of second request, but let's check
    // by looking at the pool after a known request
    const res = await app.inject({ url: '/dashboard' });
    expect(res.status).toBe(200);

    // After dashboard, pool metrics should show 3 queries
    // (metrics are reset on each request by dbAnalytics plugin)
    const metrics = tracked.metrics;
    expect(metrics.queryCount).toBe(3);
    expect(metrics.dbTime).toBeGreaterThan(0);
    expect(metrics.queries).toHaveLength(3);
  });

  it('metrics reset between requests', async () => {
    const { app, tracked } = buildDbApp();

    // Dashboard: 3 queries
    await app.inject({ url: '/dashboard' });

    // Users: 1 query — metrics should be reset
    await app.inject({ url: '/users' });

    const metrics = tracked.metrics;
    expect(metrics.queryCount).toBe(1);
  });

  // ─── No DB route ───

  it('health route works without DB and no timing header', async () => {
    const { app } = buildDbApp();
    const res = await app.inject({ url: '/health' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    // No queries = no Server-Timing header
    const timing = res.headers.get('server-timing');
    expect(timing).toBeNull();
  });

  // ─── Query logging ───

  it('mock pool logs all queries', async () => {
    const { app, mockPool } = buildDbApp();
    await app.inject({ url: '/users' });
    await app.inject({ url: '/dashboard' });

    // Total: 1 (users) + 3 (dashboard) = 4 queries
    expect(mockPool.queryLog).toHaveLength(4);
  });
});
