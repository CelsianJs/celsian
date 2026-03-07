// @celsian/core — Database analytics wrapper
// Instruments every query with timing, surfaces DB vs server time

import type { DatabasePool, TransactionCapablePool, TransactionClient } from './database.js';
import type { PluginFunction } from '../types.js';

export interface QueryMetric {
  sql: string;
  duration: number;
  timestamp: number;
}

export interface RequestMetrics {
  /** Total DB time in ms for this request */
  dbTime: number;
  /** Number of queries executed */
  queryCount: number;
  /** Individual query timings */
  queries: QueryMetric[];
}

export interface TrackedPool extends DatabasePool {
  metrics: RequestMetrics;
  resetMetrics(): void;
}

/**
 * Wrap a database pool with analytics tracking.
 * Every query() call is timed and metrics are collected.
 *
 * Call `pool.resetMetrics()` at the start of each request to get per-request metrics.
 * Or use the `dbAnalytics()` plugin which handles this automatically.
 *
 * @example
 * ```ts
 * import { trackedPool, database, dbAnalytics } from '@celsian/core';
 *
 * const pool = trackedPool(myPgPool);
 * app.register(database({ createPool: () => pool }));
 * app.register(dbAnalytics(), { encapsulate: false });
 *
 * // In handlers, access metrics:
 * app.get('/users', async (req, reply) => {
 *   const users = await req.db.query('SELECT * FROM users');
 *   const metrics = req.db.metrics; // { dbTime: 12, queryCount: 1, queries: [...] }
 *   return reply.json(users);
 * });
 * // Response includes: Server-Timing: db;dur=12.5;desc="1 queries"
 * ```
 */
export function trackedPool<T extends DatabasePool>(pool: T): T & TrackedPool {
  const metrics: RequestMetrics = { dbTime: 0, queryCount: 0, queries: [] };

  const tracked = {
    async query(sql: string, params?: unknown[]): Promise<unknown> {
      const start = performance.now();
      try {
        return await pool.query(sql, params);
      } finally {
        const duration = performance.now() - start;
        metrics.dbTime += duration;
        metrics.queryCount++;
        metrics.queries.push({ sql, duration, timestamp: Date.now() });
      }
    },

    isHealthy: pool.isHealthy?.bind(pool),
    close: pool.close.bind(pool),

    get metrics(): RequestMetrics {
      return { ...metrics, queries: [...metrics.queries] };
    },

    resetMetrics() {
      metrics.dbTime = 0;
      metrics.queryCount = 0;
      metrics.queries.length = 0;
    },
  };

  // Preserve transaction support if the pool has it
  if ('beginTransaction' in pool && typeof (pool as TransactionCapablePool).beginTransaction === 'function') {
    const txPool = pool as TransactionCapablePool;
    (tracked as unknown as TransactionCapablePool).beginTransaction = async () => {
      const start = performance.now();
      const tx = await txPool.beginTransaction();
      const duration = performance.now() - start;
      metrics.dbTime += duration;
      metrics.queryCount++;
      metrics.queries.push({ sql: 'BEGIN', duration, timestamp: Date.now() });

      return trackedTransaction(tx, metrics);
    };
  }

  return tracked as T & TrackedPool;
}

function trackedTransaction(tx: TransactionClient, metrics: RequestMetrics): TransactionClient {
  return {
    async query(sql: string, params?: unknown[]): Promise<unknown> {
      const start = performance.now();
      try {
        return await tx.query(sql, params);
      } finally {
        const duration = performance.now() - start;
        metrics.dbTime += duration;
        metrics.queryCount++;
        metrics.queries.push({ sql, duration, timestamp: Date.now() });
      }
    },
    async commit(): Promise<void> {
      const start = performance.now();
      try {
        return await tx.commit();
      } finally {
        const duration = performance.now() - start;
        metrics.dbTime += duration;
        metrics.queryCount++;
        metrics.queries.push({ sql: 'COMMIT', duration, timestamp: Date.now() });
      }
    },
    async rollback(): Promise<void> {
      const start = performance.now();
      try {
        return await tx.rollback();
      } finally {
        const duration = performance.now() - start;
        metrics.dbTime += duration;
        metrics.queryCount++;
        metrics.queries.push({ sql: 'ROLLBACK', duration, timestamp: Date.now() });
      }
    },
  };
}

/**
 * Plugin that auto-resets metrics per request and adds Server-Timing header.
 * Register with `{ encapsulate: false }` to apply globally.
 *
 * @example
 * ```ts
 * app.register(dbAnalytics({ poolName: 'db', slowThreshold: 100 }), { encapsulate: false });
 * ```
 */
export function dbAnalytics(options?: {
  poolName?: string;
  /** Log queries slower than this (ms). Default: 100 */
  slowThreshold?: number;
  /** Add Server-Timing header. Default: true */
  serverTiming?: boolean;
}): PluginFunction {
  const poolName = options?.poolName ?? 'db';
  const slowThreshold = options?.slowThreshold ?? 100;
  const serverTiming = options?.serverTiming ?? true;

  return function dbAnalyticsPlugin(app) {
    // Reset metrics at the start of each request
    app.addHook('onRequest', (request) => {
      const pool = (request as Record<string, unknown>)[poolName] as TrackedPool | undefined;
      pool?.resetMetrics();
    });

    // Add Server-Timing header and log slow queries on response
    if (serverTiming) {
      app.addHook('onSend', (request, reply) => {
        const pool = (request as Record<string, unknown>)[poolName] as TrackedPool | undefined;
        if (!pool?.metrics) return;
        const { dbTime, queryCount } = pool.metrics;
        if (queryCount > 0) {
          (reply as any).header(
            'server-timing',
            `db;dur=${dbTime.toFixed(1)};desc="${queryCount} queries"`,
          );
        }
      });
    }

    // Log slow queries
    if (slowThreshold > 0) {
      app.addHook('onResponse', (request) => {
        const pool = (request as Record<string, unknown>)[poolName] as TrackedPool | undefined;
        if (!pool?.metrics) return;
        for (const q of pool.metrics.queries) {
          if (q.duration >= slowThreshold) {
            const log = (request as any).log;
            log?.warn('slow query', { sql: q.sql, duration: Math.round(q.duration), threshold: slowThreshold });
          }
        }
      });
    }
  };
}

/**
 * Standalone hook: adds Server-Timing header with DB metrics.
 * Use this if you don't want the full dbAnalytics plugin.
 */
export function dbTimingHeader(options?: { poolName?: string }) {
  const poolName = options?.poolName ?? 'db';

  return (request: Record<string, unknown>, reply: Record<string, unknown>) => {
    const pool = request[poolName] as { metrics?: RequestMetrics } | undefined;
    if (!pool?.metrics) return;

    const { dbTime, queryCount } = pool.metrics;
    const replyObj = reply as { header?: (key: string, value: string) => void };
    if (typeof replyObj.header === 'function') {
      replyObj.header(
        'server-timing',
        `db;dur=${dbTime.toFixed(1)};desc="${queryCount} queries"`,
      );
    }
  };
}

/**
 * Standalone hook: logs queries exceeding a threshold.
 */
export function slowQueryLogger(options?: { threshold?: number; poolName?: string }) {
  const threshold = options?.threshold ?? 100;
  const poolName = options?.poolName ?? 'db';

  return (request: Record<string, unknown>) => {
    const pool = request[poolName] as { metrics?: RequestMetrics } | undefined;
    if (!pool?.metrics) return;

    for (const q of pool.metrics.queries) {
      if (q.duration >= threshold) {
        const log = (request as { log?: { warn: (...args: unknown[]) => void } }).log;
        log?.warn('slow query', { sql: q.sql, duration: Math.round(q.duration), threshold });
      }
    }
  };
}
