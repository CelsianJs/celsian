import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { HttpError } from '../src/errors.js';
import {
  database,
  withTransaction,
  transactionLifecycle,
  type DatabasePool,
  type TransactionCapablePool,
  type TransactionClient,
} from '../src/plugins/database.js';

function createMockPool(): DatabasePool & { closed: boolean; queries: string[] } {
  const pool = {
    closed: false,
    queries: [] as string[],
    async query(sql: string) {
      pool.queries.push(sql);
      if (sql === 'SELECT 1') return [{ result: 1 }];
      return [];
    },
    async isHealthy() {
      return !pool.closed;
    },
    async close() {
      pool.closed = true;
    },
  };
  return pool;
}

function createMockTxPool(): TransactionCapablePool & { txLog: string[] } {
  const txLog: string[] = [];
  return {
    txLog,
    async query(sql: string) {
      txLog.push(`pool:${sql}`);
      return [];
    },
    async isHealthy() { return true; },
    async close() {},
    async beginTransaction(): Promise<TransactionClient> {
      txLog.push('BEGIN');
      return {
        async query(sql: string) {
          txLog.push(`tx:${sql}`);
          return [];
        },
        async commit() { txLog.push('COMMIT'); },
        async rollback() { txLog.push('ROLLBACK'); },
      };
    },
  };
}

describe('Database Plugin', () => {
  it('should decorate app with db pool', async () => {
    const mockPool = createMockPool();
    const app = createApp();
    await app.register(database({ createPool: () => mockPool }), { encapsulate: false });

    expect(app.getDecoration('db')).toBe(mockPool);
  });

  it('should make db available on request', async () => {
    const mockPool = createMockPool();
    const app = createApp();
    await app.register(database({ createPool: () => mockPool }), { encapsulate: false });

    app.get('/query', async (req, reply) => {
      const db = (req as Record<string, unknown>).db as DatabasePool;
      const result = await db.query('SELECT 1');
      return reply.json({ result });
    });

    const response = await app.inject({ url: '/query' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toEqual([{ result: 1 }]);
    expect(mockPool.queries).toContain('SELECT 1');
  });

  it('should support custom decoration name', async () => {
    const mockPool = createMockPool();
    const app = createApp();
    await app.register(database({ createPool: () => mockPool, name: 'postgres' }), { encapsulate: false });

    expect(app.getDecoration('postgres')).toBe(mockPool);
  });

  it('should support async pool creation', async () => {
    const app = createApp();
    await app.register(database({
      createPool: async () => {
        await new Promise(r => setTimeout(r, 10));
        return createMockPool();
      },
    }), { encapsulate: false });

    expect(app.getDecoration('db')).toBeDefined();
  });

  it('should support health check via isHealthy', async () => {
    const mockPool = createMockPool();
    const app = createApp();
    await app.register(database({ createPool: () => mockPool }), { encapsulate: false });

    const db = app.getDecoration('db') as DatabasePool;
    expect(await db.isHealthy!()).toBe(true);

    await db.close();
    expect(await db.isHealthy!()).toBe(false);
  });
});

describe('Transaction Middleware', () => {
  it('should auto-commit on successful request', async () => {
    const txPool = createMockTxPool();
    const app = createApp();
    await app.register(database({ createPool: () => txPool }), { encapsulate: false });
    await app.register(transactionLifecycle(), { encapsulate: false });

    app.route({
      method: 'POST',
      url: '/create',
      preHandler: withTransaction(),
      handler: async (req, reply) => {
        const tx = (req as Record<string, unknown>).tx as TransactionClient;
        await tx.query('INSERT INTO users (name) VALUES ($1)');
        return reply.json({ ok: true });
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/create',
    });
    expect(response.status).toBe(200);
    expect(txPool.txLog).toEqual(['BEGIN', 'tx:INSERT INTO users (name) VALUES ($1)', 'COMMIT']);
  });

  it('should auto-rollback on handler error', async () => {
    const txPool = createMockTxPool();
    const app = createApp();
    await app.register(database({ createPool: () => txPool }), { encapsulate: false });
    await app.register(transactionLifecycle(), { encapsulate: false });

    app.route({
      method: 'POST',
      url: '/fail',
      preHandler: withTransaction(),
      handler: async (req) => {
        const tx = (req as Record<string, unknown>).tx as TransactionClient;
        await tx.query('INSERT INTO users (name) VALUES ($1)');
        throw new HttpError(400, 'Validation failed');
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/fail',
    });
    expect(response.status).toBe(400);
    expect(txPool.txLog).toEqual(['BEGIN', 'tx:INSERT INTO users (name) VALUES ($1)', 'ROLLBACK']);
  });

  it('should throw if pool lacks beginTransaction', async () => {
    const basicPool = createMockPool();
    const app = createApp();
    await app.register(database({ createPool: () => basicPool }), { encapsulate: false });

    app.route({
      method: 'POST',
      url: '/tx',
      preHandler: withTransaction(),
      handler: async (_req, reply) => reply.json({ ok: true }),
    });

    const response = await app.inject({ method: 'POST', url: '/tx' });
    expect(response.status).toBe(500);
  });

  it('should not commit if no transaction was started', async () => {
    const app = createApp();
    await app.register(transactionLifecycle(), { encapsulate: false });

    app.get('/no-tx', (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: '/no-tx' });
    expect(response.status).toBe(200);
  });
});
