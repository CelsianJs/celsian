// Real-world test: Database analytics wrapper pattern

import type { CelsianApp } from "../packages/core/src/app.js";
import { createApp } from "../packages/core/src/app.js";
import type { TrackedPool } from "../packages/core/src/plugins/analytics.js";
import { dbAnalytics, trackedPool } from "../packages/core/src/plugins/analytics.js";
import type { DatabasePool } from "../packages/core/src/plugins/database.js";
import { database } from "../packages/core/src/plugins/database.js";

// Mock database pool that simulates query latency
export function createMockPool(latencyMs = 5): DatabasePool & { queryLog: string[] } {
  const queryLog: string[] = [];

  return {
    queryLog,
    async query(sql: string, _params?: unknown[]) {
      queryLog.push(sql);
      // Simulate query latency
      await new Promise((r) => setTimeout(r, latencyMs));

      // Return mock data based on SQL
      if (sql.startsWith("SELECT")) {
        return { rows: [{ id: 1, name: "Mock" }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT")) {
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async close() {
      // no-op
    },
  };
}

export function buildDbApp(opts?: { slowThreshold?: number; latencyMs?: number }): {
  app: CelsianApp;
  mockPool: ReturnType<typeof createMockPool>;
  tracked: TrackedPool;
} {
  const app = createApp();
  const mockPool = createMockPool(opts?.latencyMs ?? 2);
  const tracked = trackedPool(mockPool);

  // Register database plugin — must be non-encapsulated so req.db is visible to all routes
  app.register(database({ createPool: () => tracked }), { encapsulate: false });

  // Register analytics plugin (non-encapsulated so it applies globally)
  app.register(
    dbAnalytics({
      slowThreshold: opts?.slowThreshold ?? 100,
      serverTiming: true,
    }),
    { encapsulate: false },
  );

  // Route that does a single query
  app.get("/users", async (req, reply) => {
    const db = (req as Record<string, unknown>).db as TrackedPool;
    const result = await db.query("SELECT * FROM users");
    return reply.json(result);
  });

  // Route that does multiple queries
  app.get("/dashboard", async (req, reply) => {
    const db = (req as Record<string, unknown>).db as TrackedPool;
    const users = await db.query("SELECT count(*) FROM users");
    const orders = await db.query("SELECT count(*) FROM orders");
    const revenue = await db.query("SELECT sum(amount) FROM payments");
    return reply.json({ users, orders, revenue });
  });

  // Route that does no DB calls (to verify no Server-Timing header)
  app.get("/health", (_req, reply) => {
    return reply.json({ status: "ok" });
  });

  return { app, mockPool, tracked };
}
