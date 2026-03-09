# Database Plugin

CelsianJS provides a database connection pool plugin with per-request analytics, transaction lifecycle management, and slow query logging.

## Setup

The database plugin decorates the app and request with a pool instance. Use `{ encapsulate: false }` so all routes can access `req.db`.

```typescript
import { createApp, serve, database } from '@celsian/core';

// Your database pool (pg, mysql2, etc.)
import { Pool } from 'pg';

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Wrap it in a CelsianJS-compatible interface
const pool = {
  async query(sql: string, params?: unknown[]) {
    const result = await pgPool.query(sql, params);
    return result.rows;
  },
  async isHealthy() {
    try {
      await pgPool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  },
  async close() {
    await pgPool.end();
  },
};

const app = createApp({ logger: true });

await app.register(database({ createPool: () => pool }), { encapsulate: false });
```

Now every handler has access to the database via `req.db`:

```typescript
app.get('/users', async (req, reply) => {
  const db = (req as any).db;
  const users = await db.query('SELECT * FROM users LIMIT 50');
  return reply.json(users);
});

app.get('/users/:id', async (req, reply) => {
  const db = (req as any).db;
  const [user] = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!user) return reply.notFound('User not found');
  return reply.json(user);
});
```

## DatabasePool Interface

The database plugin accepts any object that implements the `DatabasePool` interface:

```typescript
interface DatabasePool {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  isHealthy?(): Promise<boolean>;
  close(): Promise<void>;
}
```

This works with any database driver. You just need to wrap it to match the interface.

### Custom Decoration Name

If you need multiple databases, use different decoration names:

```typescript
await app.register(database({
  createPool: () => primaryPool,
  name: 'db',
}), { encapsulate: false });

await app.register(database({
  createPool: () => analyticsPool,
  name: 'analyticsDb',
}), { encapsulate: false });

// In handlers:
const primary = (req as any).db;
const analytics = (req as any).analyticsDb;
```

## Query Analytics

Wrap your pool with `trackedPool()` to instrument every query with timing:

```typescript
import { database, trackedPool, dbAnalytics } from '@celsian/core';

const pool = trackedPool({
  async query(sql, params) { /* ... */ },
  async close() { /* ... */ },
});

await app.register(database({ createPool: () => pool }), { encapsulate: false });
await app.register(dbAnalytics(), { encapsulate: false });
```

This gives you three things automatically:

### 1. Per-Request Metrics

Metrics are reset at the start of each request and accumulated as queries execute:

```typescript
app.get('/dashboard', async (req, reply) => {
  const db = (req as any).db;

  const users = await db.query('SELECT count(*) FROM users');
  const orders = await db.query('SELECT count(*) FROM orders');
  const revenue = await db.query('SELECT sum(total) FROM orders WHERE created_at > $1', [lastMonth]);

  // Access metrics
  const metrics = db.metrics;
  // {
  //   dbTime: 15.3,       // Total DB time in ms
  //   queryCount: 3,       // Number of queries
  //   queries: [           // Individual timings
  //     { sql: 'SELECT count(*) FROM users', duration: 4.1, timestamp: ... },
  //     { sql: 'SELECT count(*) FROM orders', duration: 5.2, timestamp: ... },
  //     { sql: 'SELECT sum(total) FROM orders WHERE ...', duration: 6.0, timestamp: ... },
  //   ]
  // }

  return reply.json({ users, orders, revenue });
});
```

### 2. Server-Timing Headers

Every response automatically includes a `Server-Timing` header:

```
Server-Timing: db;dur=15.3;desc="3 queries"
```

This shows up in browser DevTools under the Timing tab, making it easy to see how much of your response time is spent in the database.

### 3. Slow Query Logging

Queries exceeding the threshold (default: 100ms) are logged as warnings:

```
WARN: slow query { sql: "SELECT * FROM orders WHERE ...", duration: 245, threshold: 100 }
```

### Configuration

```typescript
await app.register(dbAnalytics({
  poolName: 'db',        // Match the database decoration name
  slowThreshold: 100,    // Log queries slower than this (ms). 0 to disable.
  serverTiming: true,    // Add Server-Timing header. Set false to disable.
}), { encapsulate: false });
```

### Standalone Hooks

If you only want part of the analytics, use the standalone hooks instead of the full plugin:

```typescript
import { dbTimingHeader, slowQueryLogger } from '@celsian/core';

// Only add Server-Timing header
app.addHook('onSend', dbTimingHeader());

// Only log slow queries
app.addHook('onResponse', slowQueryLogger({ threshold: 200 }));
```

## Transactions

CelsianJS provides automatic transaction lifecycle management. Transactions auto-commit on success and auto-rollback on error.

### Transaction-Capable Pool

Your pool must implement `beginTransaction()`:

```typescript
import type { TransactionCapablePool, TransactionClient } from '@celsian/core';

const pool: TransactionCapablePool = {
  async query(sql, params) {
    return pgPool.query(sql, params).then(r => r.rows);
  },
  async beginTransaction(): Promise<TransactionClient> {
    const client = await pgPool.connect();
    await client.query('BEGIN');
    return {
      async query(sql, params) {
        return client.query(sql, params).then(r => r.rows);
      },
      async commit() {
        await client.query('COMMIT');
        client.release();
      },
      async rollback() {
        await client.query('ROLLBACK');
        client.release();
      },
    };
  },
  async close() {
    await pgPool.end();
  },
};
```

### Using Transactions

Register the transaction lifecycle plugin and use the `withTransaction()` hook:

```typescript
import { database, withTransaction, transactionLifecycle } from '@celsian/core';

await app.register(database({ createPool: () => pool }), { encapsulate: false });
await app.register(transactionLifecycle(), { encapsulate: false });

app.route({
  method: 'POST',
  url: '/transfer',
  preHandler: [withTransaction()],
  async handler(req, reply) {
    const tx = (req as any).tx;
    const body = req.parsedBody as { from: string; to: string; amount: number };

    await tx.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [body.amount, body.from]);
    await tx.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [body.amount, body.to]);

    // Transaction auto-commits when the handler returns successfully.
    // If an error is thrown, it auto-rollbacks.
    return reply.json({ success: true });
  },
});
```

How it works:

1. `withTransaction()` is a `preHandler` hook. It calls `pool.beginTransaction()` and attaches the transaction client to `req.tx`.
2. `transactionLifecycle()` registers two hooks:
   - `onSend`: If `req.tx` exists and is pending, call `tx.commit()`.
   - `onError`: If `req.tx` exists and is pending, call `tx.rollback()`.

### Tracked Transactions

`trackedPool()` preserves transaction support. If your pool implements `beginTransaction()`, the tracked wrapper will instrument transaction queries too:

```typescript
const tracked = trackedPool(pool);
// tracked.beginTransaction() is available
// BEGIN, COMMIT, ROLLBACK, and all queries within the transaction are timed
```

## Health Checks with Database

Combine the health check endpoint with database health:

```typescript
app.health({
  check: async () => {
    const db = app.getDecoration('db') as DatabasePool;
    return db.isHealthy?.() ?? true;
  },
});
```

This returns `503 Service Unavailable` when the database is unreachable, which is picked up by load balancers and orchestrators (Kubernetes, Fly.io, Railway).

## Full Example

```typescript
import { createApp, serve, cors, security, database, trackedPool, dbAnalytics, withTransaction, transactionLifecycle } from '@celsian/core';
import { Pool } from 'pg';

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

const pool = trackedPool({
  async query(sql, params) {
    return pgPool.query(sql, params).then(r => r.rows);
  },
  async beginTransaction() {
    const client = await pgPool.connect();
    await client.query('BEGIN');
    return {
      query: (sql, params) => client.query(sql, params).then(r => r.rows),
      commit: async () => { await client.query('COMMIT'); client.release(); },
      rollback: async () => { await client.query('ROLLBACK'); client.release(); },
    };
  },
  async isHealthy() {
    try { await pgPool.query('SELECT 1'); return true; } catch { return false; }
  },
  async close() { await pgPool.end(); },
});

const app = createApp({ logger: true });

await app.register(security(), { encapsulate: false });
await app.register(cors(), { encapsulate: false });
await app.register(database({ createPool: () => pool }), { encapsulate: false });
await app.register(dbAnalytics({ slowThreshold: 100 }), { encapsulate: false });
await app.register(transactionLifecycle(), { encapsulate: false });

app.health({ check: () => pool.isHealthy!() });

app.get('/users', async (req, reply) => {
  const db = (req as any).db;
  const users = await db.query('SELECT id, name, email FROM users');
  return reply.json(users);
});

app.route({
  method: 'POST',
  url: '/transfer',
  preHandler: [withTransaction()],
  async handler(req, reply) {
    const tx = (req as any).tx;
    const { from, to, amount } = req.parsedBody as { from: string; to: string; amount: number };
    await tx.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, from]);
    await tx.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, to]);
    return reply.json({ success: true });
  },
});

serve(app, {
  port: 3000,
  async onShutdown() {
    await pool.close();
  },
});
```
