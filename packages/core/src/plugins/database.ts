// @celsian/core — Database connection pool plugin

import type { PluginFunction, HookHandler } from '../types.js';

export interface DatabasePool {
  /** Execute a query */
  query(sql: string, params?: unknown[]): Promise<unknown>;
  /** Check if the pool is healthy (for readiness probes) */
  isHealthy?(): Promise<boolean>;
  /** Close all connections */
  close(): Promise<void>;
}

/** Extended pool interface for transaction support */
export interface TransactionCapablePool extends DatabasePool {
  /** Begin a transaction and return a transaction client */
  beginTransaction(): Promise<TransactionClient>;
}

export interface TransactionClient {
  /** Execute a query within the transaction */
  query(sql: string, params?: unknown[]): Promise<unknown>;
  /** Commit the transaction */
  commit(): Promise<void>;
  /** Rollback the transaction */
  rollback(): Promise<void>;
}

export interface DatabaseOptions<T extends DatabasePool = DatabasePool> {
  /** Factory function to create the pool (called once on plugin registration) */
  createPool: () => T | Promise<T>;
  /** Decoration name on app and request (default: 'db') */
  name?: string;
}

export function database<T extends DatabasePool>(options: DatabaseOptions<T>): PluginFunction {
  return async function databasePlugin(app) {
    const name = options.name ?? 'db';
    const pool = await options.createPool();

    // Decorate app with the pool
    app.decorate(name, pool);

    // Decorate request so handlers can access req.db
    app.decorateRequest(name, pool);
  };
}

/**
 * Create a preHandler hook that wraps the request in a database transaction.
 * Auto-commits on success, auto-rollbacks on error.
 * The transaction client is available as `req.tx`.
 */
export function withTransaction(options?: { poolName?: string }): HookHandler {
  const poolName = options?.poolName ?? 'db';

  return async (request, _reply) => {
    const pool = (request as Record<string, unknown>)[poolName] as TransactionCapablePool | undefined;
    if (!pool || typeof pool.beginTransaction !== 'function') {
      throw new Error(
        `withTransaction: no transaction-capable pool found at request.${poolName}. ` +
        `Register the database plugin first and ensure your pool implements beginTransaction().`
      );
    }

    const tx = await pool.beginTransaction();
    (request as Record<string, unknown>).tx = tx;

    // Store a cleanup flag — the onResponse hook will commit/rollback
    (request as Record<string, unknown>)._txPending = true;
  };
}

/**
 * Plugin that auto-commits/rollbacks transactions set up by withTransaction().
 * Register this once globally: app.register(transactionLifecycle(), { encapsulate: false })
 */
export function transactionLifecycle(): PluginFunction {
  return function transactionLifecyclePlugin(app) {
    // On successful response, commit
    app.addHook('onSend', async (request) => {
      const tx = (request as Record<string, unknown>).tx as TransactionClient | undefined;
      const pending = (request as Record<string, unknown>)._txPending;
      if (tx && pending) {
        await tx.commit();
        (request as Record<string, unknown>)._txPending = false;
      }
    });

    // On error, rollback
    app.addHook('onError', async (_error, request) => {
      const tx = (request as Record<string, unknown>).tx as TransactionClient | undefined;
      const pending = (request as Record<string, unknown>)._txPending;
      if (tx && pending) {
        await tx.rollback();
        (request as Record<string, unknown>)._txPending = false;
      }
    });
  };
}
