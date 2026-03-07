import { describe, it, expect, vi } from 'vitest';
import { trackedPool, dbTimingHeader, slowQueryLogger } from '../src/plugins/analytics.js';
import type { DatabasePool, TransactionCapablePool, TransactionClient } from '../src/plugins/database.js';

function createMockPool(): DatabasePool {
  return {
    async query(sql: string) {
      await new Promise((r) => setTimeout(r, 5)); // simulate 5ms query
      return [{ id: 1, name: 'test' }];
    },
    async close() {},
  };
}

function createMockTxPool(): TransactionCapablePool {
  return {
    ...createMockPool(),
    async beginTransaction(): Promise<TransactionClient> {
      await new Promise((r) => setTimeout(r, 1));
      return {
        async query(sql: string) {
          await new Promise((r) => setTimeout(r, 2));
          return [];
        },
        async commit() {
          await new Promise((r) => setTimeout(r, 1));
        },
        async rollback() {
          await new Promise((r) => setTimeout(r, 1));
        },
      };
    },
  };
}

describe('trackedPool', () => {
  it('should track query timing', async () => {
    const pool = trackedPool(createMockPool());
    await pool.query('SELECT * FROM users');

    const metrics = pool.metrics;
    expect(metrics.queryCount).toBe(1);
    expect(metrics.dbTime).toBeGreaterThan(0);
    expect(metrics.queries).toHaveLength(1);
    expect(metrics.queries[0].sql).toBe('SELECT * FROM users');
    expect(metrics.queries[0].duration).toBeGreaterThan(0);
  });

  it('should accumulate across multiple queries', async () => {
    const pool = trackedPool(createMockPool());
    await pool.query('SELECT 1');
    await pool.query('SELECT 2');
    await pool.query('SELECT 3');

    const metrics = pool.metrics;
    expect(metrics.queryCount).toBe(3);
    expect(metrics.queries).toHaveLength(3);
    expect(metrics.dbTime).toBeGreaterThan(0);
  });

  it('should reset metrics', async () => {
    const pool = trackedPool(createMockPool());
    await pool.query('SELECT 1');
    expect(pool.metrics.queryCount).toBe(1);

    pool.resetMetrics();
    expect(pool.metrics.queryCount).toBe(0);
    expect(pool.metrics.dbTime).toBe(0);
    expect(pool.metrics.queries).toHaveLength(0);
  });

  it('should preserve close and isHealthy', async () => {
    const mock = createMockPool();
    mock.isHealthy = async () => true;
    const pool = trackedPool(mock);

    expect(await pool.isHealthy!()).toBe(true);
    await pool.close(); // should not throw
  });

  it('should track timing even when query throws', async () => {
    const mock: DatabasePool = {
      async query() { throw new Error('DB error'); },
      async close() {},
    };
    const pool = trackedPool(mock);

    await expect(pool.query('BAD SQL')).rejects.toThrow('DB error');
    expect(pool.metrics.queryCount).toBe(1);
    expect(pool.metrics.queries[0].sql).toBe('BAD SQL');
    expect(pool.metrics.queries[0].duration).toBeGreaterThanOrEqual(0);
  });

  it('should track transaction queries', async () => {
    const pool = trackedPool(createMockTxPool());
    const tx = await (pool as TransactionCapablePool).beginTransaction();
    await tx.query('INSERT INTO users (name) VALUES ($1)');
    await tx.query('INSERT INTO logs (msg) VALUES ($1)');
    await tx.commit();

    const metrics = pool.metrics;
    // BEGIN + 2 queries + COMMIT = 4
    expect(metrics.queryCount).toBe(4);
    expect(metrics.queries.find((q) => q.sql === 'BEGIN')).toBeDefined();
    expect(metrics.queries.find((q) => q.sql === 'COMMIT')).toBeDefined();
  });

  it('should track rollback in transactions', async () => {
    const pool = trackedPool(createMockTxPool());
    const tx = await (pool as TransactionCapablePool).beginTransaction();
    await tx.query('INSERT INTO users (name) VALUES ($1)');
    await tx.rollback();

    const metrics = pool.metrics;
    expect(metrics.queries.find((q) => q.sql === 'ROLLBACK')).toBeDefined();
  });
});

describe('dbTimingHeader', () => {
  it('should set Server-Timing header', () => {
    const hook = dbTimingHeader();
    const headers: Record<string, string> = {};
    const request = {
      db: {
        metrics: { dbTime: 12.5, queryCount: 3, queries: [] },
      },
    };
    const reply = {
      header(key: string, value: string) { headers[key] = value; },
    };

    hook(request as any, reply as any);
    expect(headers['server-timing']).toBe('db;dur=12.5;desc="3 queries"');
  });

  it('should handle missing pool gracefully', () => {
    const hook = dbTimingHeader();
    const reply = { header: vi.fn() };
    hook({} as any, reply as any);
    expect(reply.header).not.toHaveBeenCalled();
  });
});

describe('slowQueryLogger', () => {
  it('should warn on slow queries', () => {
    const warnMock = vi.fn();
    const hook = slowQueryLogger({ threshold: 10 });
    const request = {
      db: {
        metrics: {
          dbTime: 150,
          queryCount: 2,
          queries: [
            { sql: 'SELECT 1', duration: 5, timestamp: Date.now() },
            { sql: 'SELECT * FROM big_table', duration: 120, timestamp: Date.now() },
          ],
        },
      },
      log: { warn: warnMock },
    };

    hook(request as any);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith('slow query', {
      sql: 'SELECT * FROM big_table',
      duration: 120,
      threshold: 10,
    });
  });

  it('should not warn when no slow queries', () => {
    const warnMock = vi.fn();
    const hook = slowQueryLogger({ threshold: 100 });
    const request = {
      db: {
        metrics: {
          dbTime: 5,
          queryCount: 1,
          queries: [{ sql: 'SELECT 1', duration: 5, timestamp: Date.now() }],
        },
      },
      log: { warn: warnMock },
    };

    hook(request as any);
    expect(warnMock).not.toHaveBeenCalled();
  });
});
