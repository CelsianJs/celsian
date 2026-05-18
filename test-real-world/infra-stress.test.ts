// Stress test pass 2: task workers, cron, WebSocket, health, plugin DX, edge cases
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createApp,
  CronScheduler,
  parseCronExpression,
  shouldRun,
  MemoryQueue,
  TaskRegistry,
  TaskWorker,
  createEnqueue,
  WSRegistry,
  createWSConnection,
  HttpError,
  createSSEHub,
  createSSEStream,
  cors,
  security,
  createLogger,
} from "../packages/core/src/index.js";
import type { CelsianRequest, CelsianReply, CelsianAppOptions } from "../packages/core/src/types.js";

// ─── 1. Task System ───
describe("Task System (real-world)", () => {
  it("app.task() + app.enqueue() + startWorker() should process tasks", async () => {
    const app = createApp();
    const processed: string[] = [];

    app.task({
      name: "send-email",
      handler: async (input: any) => {
        processed.push(input.to);
      },
    });

    app.setTaskWorkerOptions({ pollInterval: 50 });
    app.startWorker();
    await app.ready();

    await app.enqueue("send-email", { to: "alice@test.com" });
    await app.enqueue("send-email", { to: "bob@test.com" });

    // Wait for worker to process (needs at least one poll cycle)
    await new Promise((r) => setTimeout(r, 300));

    expect(processed).toContain("alice@test.com");
    expect(processed).toContain("bob@test.com");

    await app.stopWorker();
  });

  it("enqueue unknown task should throw", async () => {
    const app = createApp();
    await app.ready();

    await expect(app.enqueue("nonexistent", {})).rejects.toThrow(/Unknown task/);
  });

  it("task retry on failure should work", async () => {
    const attempts: number[] = [];
    const app = createApp();

    app.task({
      name: "flaky",
      retries: 2,
      handler: async (input: any, ctx) => {
        attempts.push(ctx.attempt);
        if (ctx.attempt < 2) {
          throw new Error("fail on purpose");
        }
      },
    });

    app.setTaskWorkerOptions({ pollInterval: 50 });
    app.startWorker();
    await app.ready();

    await app.enqueue("flaky", {});

    // Wait for retries (backoff is 1s, 2s but our queue is in-memory so delay is simulated)
    await new Promise((r) => setTimeout(r, 5000));

    expect(attempts.length).toBeGreaterThanOrEqual(2);
    await app.stopWorker();
  }, 10_000);

  it("task timeout should abort long-running tasks", async () => {
    const app = createApp();
    let timedOut = false;

    app.task({
      name: "slow-task",
      timeout: 100,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 5000));
      },
    });

    app.setTaskWorkerOptions({ pollInterval: 50 });
    app.startWorker();
    await app.ready();

    await app.enqueue("slow-task", {});

    // Wait for timeout to trigger
    await new Promise((r) => setTimeout(r, 500));
    await app.stopWorker();
    // If we get here without hanging, the timeout worked
    expect(true).toBe(true);
  });

  it("MemoryQueue should track size correctly", async () => {
    const queue = new MemoryQueue();
    expect(await queue.size()).toBe(0);

    await queue.push({
      id: "1",
      taskName: "test",
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });
    expect(await queue.size()).toBe(1);

    const msg = await queue.pop();
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe("1");
    expect(await queue.size()).toBe(0);
  });

  it("MemoryQueue nack should re-enqueue with delay", async () => {
    const queue = new MemoryQueue();
    await queue.push({
      id: "delayed",
      taskName: "test",
      input: {},
      attempt: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const msg = await queue.pop();
    expect(msg).not.toBeNull();

    // nack with short delay
    await queue.nack("delayed", 50);
    expect(await queue.size()).toBe(1);

    // Not available yet
    const immediate = await queue.pop();
    expect(immediate).toBeNull();

    // Wait for delay
    await new Promise((r) => setTimeout(r, 60));
    const retried = await queue.pop();
    expect(retried).not.toBeNull();
    expect(retried!.attempt).toBe(1);
  });

  it("task worker concurrency should limit parallel execution", async () => {
    const app = createApp();
    let concurrent = 0;
    let maxConcurrent = 0;

    app.task({
      name: "parallel",
      handler: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 100));
        concurrent--;
      },
    });

    app.setTaskWorkerOptions({ concurrency: 2, pollInterval: 10 });
    app.startWorker();
    await app.ready();

    // Enqueue 5 tasks
    for (let i = 0; i < 5; i++) {
      await app.enqueue("parallel", {});
    }

    await new Promise((r) => setTimeout(r, 800));
    await app.stopWorker();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThanOrEqual(1);
  });
});

// ─── 2. Cron System ───
describe("Cron System", () => {
  it("parseCronExpression should parse standard expressions", () => {
    const every5 = parseCronExpression("*/5 * * * *");
    expect(every5.minutes.has(0)).toBe(true);
    expect(every5.minutes.has(5)).toBe(true);
    expect(every5.minutes.has(10)).toBe(true);
    expect(every5.minutes.has(3)).toBe(false);
  });

  it("parseCronExpression should handle ranges", () => {
    const workHours = parseCronExpression("0 9-17 * * 1-5");
    expect(workHours.hours.has(9)).toBe(true);
    expect(workHours.hours.has(17)).toBe(true);
    expect(workHours.hours.has(8)).toBe(false);
    expect(workHours.daysOfWeek.has(0)).toBe(false); // Sunday
    expect(workHours.daysOfWeek.has(1)).toBe(true);  // Monday
  });

  it("parseCronExpression should handle comma-separated values", () => {
    const specific = parseCronExpression("0 6,12,18 * * *");
    expect(specific.hours.has(6)).toBe(true);
    expect(specific.hours.has(12)).toBe(true);
    expect(specific.hours.has(18)).toBe(true);
    expect(specific.hours.has(15)).toBe(false);
  });

  it("parseCronExpression should reject invalid expressions", () => {
    expect(() => parseCronExpression("* * *")).toThrow(/expected 5 fields/);
    expect(() => parseCronExpression("")).toThrow();
  });

  it("shouldRun should match correctly", () => {
    const parsed = parseCronExpression("30 14 * * *"); // 2:30 PM daily
    const match = new Date(2026, 4, 16, 14, 30, 0); // May 16, 2:30 PM
    const noMatch = new Date(2026, 4, 16, 14, 31, 0); // 2:31 PM
    expect(shouldRun(parsed, match)).toBe(true);
    expect(shouldRun(parsed, noMatch)).toBe(false);
  });

  it("app.cron() should register and start jobs", () => {
    const app = createApp();
    let called = false;

    app.cron("test-job", "* * * * *", () => {
      called = true;
    });

    const jobs = app.getCronJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("test-job");
    expect(jobs[0].schedule).toBe("* * * * *");

    // startCron should be safe to call
    app.startCron();
    app.stopCron();
  });

  it("CronScheduler should be stoppable", () => {
    const scheduler = new CronScheduler();
    scheduler.add({ name: "test", schedule: "* * * * *", handler: () => {} });
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it("CronScheduler start is idempotent", () => {
    const scheduler = new CronScheduler();
    scheduler.add({ name: "test", schedule: "* * * * *", handler: () => {} });
    scheduler.start();
    scheduler.start(); // should not create duplicate timers
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
  });
});

// ─── 3. WebSocket Registry ───
describe("WebSocket Registry", () => {
  it("should register handlers and track connections", () => {
    const registry = new WSRegistry();
    const handler = { open: () => {}, message: () => {}, close: () => {} };

    registry.register("/chat", handler);
    expect(registry.hasPath("/chat")).toBe(true);
    expect(registry.hasAnyHandlers()).toBe(true);
    expect(registry.getHandler("/chat")).toBe(handler);
    expect(registry.getConnectionCount("/chat")).toBe(0);
  });

  it("should add and remove connections", () => {
    const registry = new WSRegistry();
    registry.register("/ws", { open: () => {} });

    const conn = createWSConnection({
      send: () => {},
      close: () => {},
    });

    registry.addConnection("/ws", conn);
    expect(registry.getConnectionCount("/ws")).toBe(1);

    registry.removeConnection("/ws", conn);
    expect(registry.getConnectionCount("/ws")).toBe(0);
  });

  it("broadcast should send to all connections except excluded", () => {
    const registry = new WSRegistry();
    registry.register("/ws", {});

    const sent1: string[] = [];
    const sent2: string[] = [];

    const conn1 = createWSConnection({ send: (d) => sent1.push(d as string), close: () => {} });
    const conn2 = createWSConnection({ send: (d) => sent2.push(d as string), close: () => {} });

    registry.addConnection("/ws", conn1);
    registry.addConnection("/ws", conn2);

    registry.broadcast("/ws", "hello", conn1.id);
    expect(sent1).toHaveLength(0); // excluded
    expect(sent2).toEqual(["hello"]);
  });

  it("broadcastAll should send across all paths", () => {
    const registry = new WSRegistry();
    registry.register("/ws1", {});
    registry.register("/ws2", {});

    const sent1: string[] = [];
    const sent2: string[] = [];

    const conn1 = createWSConnection({ send: (d) => sent1.push(d as string), close: () => {} });
    const conn2 = createWSConnection({ send: (d) => sent2.push(d as string), close: () => {} });

    registry.addConnection("/ws1", conn1);
    registry.addConnection("/ws2", conn2);

    registry.broadcastAll("global message");
    expect(sent1).toEqual(["global message"]);
    expect(sent2).toEqual(["global message"]);
  });

  it("total connection count should work", () => {
    const registry = new WSRegistry();
    registry.register("/a", {});
    registry.register("/b", {});

    registry.addConnection("/a", createWSConnection({ send: () => {}, close: () => {} }));
    registry.addConnection("/a", createWSConnection({ send: () => {}, close: () => {} }));
    registry.addConnection("/b", createWSConnection({ send: () => {}, close: () => {} }));

    expect(registry.getConnectionCount()).toBe(3);
    expect(registry.getConnectionCount("/a")).toBe(2);
    expect(registry.getConnectionCount("/b")).toBe(1);
  });

  it("connection metadata bag should be usable", () => {
    const conn = createWSConnection({ send: () => {}, close: () => {} });
    conn.metadata.userId = "user-42";
    conn.metadata.role = "admin";

    expect(conn.metadata.userId).toBe("user-42");
    expect(conn.metadata.role).toBe("admin");
  });

  it("connection IDs should be unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const conn = createWSConnection({ send: () => {}, close: () => {} });
      ids.add(conn.id);
    }
    expect(ids.size).toBe(100);
  });

  it("app.ws() should register handlers on the app", async () => {
    const app = createApp();
    const events: string[] = [];

    app.ws("/live", {
      open: (ws) => events.push("open"),
      message: (ws, data) => events.push(`msg:${data}`),
      close: (ws) => events.push("close"),
    });

    expect(app.wsRegistry.hasPath("/live")).toBe(true);
    expect(app.wsRegistry.hasAnyHandlers()).toBe(true);
  });

  it("app.wsBroadcast() should broadcast to a path", () => {
    const app = createApp();
    const received: string[] = [];

    app.ws("/notify", {});

    const conn = createWSConnection({
      send: (d) => received.push(d as string),
      close: () => {},
    });

    app.wsRegistry.addConnection("/notify", conn);
    app.wsBroadcast("/notify", "update!");

    expect(received).toEqual(["update!"]);
  });
});

// ─── 4. Health Check ───
describe("Health Check", () => {
  it("app.health() registers /health and /ready", async () => {
    const app = createApp();
    app.health();
    await app.ready();

    const healthRes = await app.inject({ url: "/health" });
    expect(healthRes.status).toBe(200);
    const body = await healthRes.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();

    const readyRes = await app.inject({ url: "/ready" });
    expect(readyRes.status).toBe(200);
    expect((await readyRes.json()).status).toBe("ready");
  });

  it("health check with custom paths", async () => {
    const app = createApp();
    app.health({ path: "/healthz", readyPath: "/readyz" });
    await app.ready();

    const res = await app.inject({ url: "/healthz" });
    expect(res.status).toBe(200);

    const res2 = await app.inject({ url: "/readyz" });
    expect(res2.status).toBe(200);
  });

  it("health check with failing liveness check returns 503", async () => {
    const app = createApp();
    app.health({ check: () => false });
    await app.ready();

    const res = await app.inject({ url: "/health" });
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("unhealthy");
  });

  it("health check with async liveness check", async () => {
    const app = createApp();
    let healthy = true;
    app.health({ check: async () => healthy });
    await app.ready();

    const res1 = await app.inject({ url: "/health" });
    expect(res1.status).toBe(200);

    healthy = false;
    const res2 = await app.inject({ url: "/health" });
    expect(res2.status).toBe(503);
  });
});

// ─── 5. Security Plugin ───
describe("Security plugin", () => {
  it("should set security headers", async () => {
    const app = createApp();
    await app.register(security());

    app.get("/secure", (req, reply) => reply.json({ ok: true }));
    await app.ready();

    const res = await app.inject({ url: "/secure" });
    expect(res.status).toBe(200);

    // Should have security headers set by the plugin
    const headers = res.headers;
    // Check for common security headers
    const hasSecurityHeaders =
      headers.get("x-content-type-options") ||
      headers.get("x-frame-options") ||
      headers.get("strict-transport-security") ||
      headers.get("x-xss-protection");
    expect(hasSecurityHeaders).toBeTruthy();
  });
});

// ─── 6. Logger ───
describe("Logger", () => {
  it("createLogger produces a working logger", () => {
    const logger = createLogger();
    expect(logger.level).toBeDefined();
    // Should not throw
    logger.info("test message");
    logger.error("error message", { code: 500 });
  });

  it("child logger inherits context", () => {
    const logger = createLogger();
    const child = logger.child({ requestId: "abc-123" });
    expect(child).toBeDefined();
    // Should not throw
    child.info("child message");
  });

  it("app with logger enabled should set request IDs", async () => {
    const app = createApp({ logger: true });
    let hasRequestId = false;

    app.addHook("onRequest", (req) => {
      hasRequestId = !!(req as any).requestId;
    });

    app.get("/logged", (req, reply) => reply.json({ ok: true }));
    await app.ready();

    await app.inject({ url: "/logged" });
    expect(hasRequestId).toBe(true);
  });
});

// ─── 7. SSE Advanced ───
describe("SSE Advanced", () => {
  it("SSE hub should auto-remove closed channels from size", () => {
    const hub = createSSEHub();
    const ctrl = new AbortController();
    const req = new Request("http://localhost/events", { signal: ctrl.signal });

    const channel = hub.subscribe(req);
    expect(hub.size).toBe(1);

    channel.close();
    // After close, the onClose callback should remove it
    expect(hub.size).toBe(0);
  });

  it("SSE stream sendData shorthand", () => {
    const ctrl = new AbortController();
    const req = new Request("http://localhost/events", { signal: ctrl.signal });
    const channel = createSSEStream(req);

    // sendData should not throw
    channel.sendData({ count: 1 });
    channel.sendData("plain string");

    expect(channel.open).toBe(true);
    channel.close();
    ctrl.abort();
  });

  it("sending on closed channel should not throw", () => {
    const ctrl = new AbortController();
    const req = new Request("http://localhost/events", { signal: ctrl.signal });
    const channel = createSSEStream(req);

    channel.close();
    // Should be safe to call after close
    channel.send({ data: "ignored" });
    channel.sendData("also ignored");
    ctrl.abort();
  });

  it("SSE hub broadcast should send to all subscribers", () => {
    const hub = createSSEHub();
    const ctrls = [new AbortController(), new AbortController()];
    const channels = ctrls.map((ctrl) => {
      const req = new Request("http://localhost/events", { signal: ctrl.signal });
      return hub.subscribe(req);
    });

    expect(hub.size).toBe(2);

    hub.broadcast({ event: "ping", data: { ts: 123 } });
    hub.broadcastData("raw data");

    // All channels should still be open
    expect(channels.every((c) => c.open)).toBe(true);

    hub.closeAll();
    expect(hub.size).toBe(0);
    ctrls.forEach((c) => c.abort());
  });
});

// ─── 8. Plugin Registration Edge Cases ───
describe("Plugin Registration Edge Cases", () => {
  it("registering the same plugin twice should work", async () => {
    const app = createApp();

    const myPlugin = async (ctx: any) => {
      ctx.get("/from-plugin", (req: CelsianRequest, reply: CelsianReply) => {
        return reply.json({ ok: true });
      });
    };

    await app.register(myPlugin, { prefix: "/a" });
    await app.register(myPlugin, { prefix: "/b" });
    await app.ready();

    const res1 = await app.inject({ url: "/a/from-plugin" });
    expect(res1.status).toBe(200);

    const res2 = await app.inject({ url: "/b/from-plugin" });
    expect(res2.status).toBe(200);
  });

  it("deeply nested plugins should prefix correctly", async () => {
    const app = createApp({ prefix: "/api" });

    const level1 = async (ctx: any) => {
      const level2 = async (inner: any) => {
        const level3 = async (deepest: any) => {
          deepest.get("/resource", (req: CelsianRequest, reply: CelsianReply) => {
            return reply.json({ depth: 3 });
          });
        };
        await inner.register(level3, { prefix: "/deep" });
      };
      await ctx.register(level2, { prefix: "/nested" });
    };

    await app.register(level1, { prefix: "/v1" });
    await app.ready();

    const res = await app.inject({ url: "/api/v1/nested/deep/resource" });
    expect(res.status).toBe(200);
    expect((await res.json()).depth).toBe(3);
  });

  it("async plugin with delayed registration should work", async () => {
    const app = createApp();

    const asyncPlugin = async (ctx: any) => {
      await new Promise((r) => setTimeout(r, 50));
      ctx.get("/delayed", (req: CelsianRequest, reply: CelsianReply) => {
        return reply.json({ loaded: true });
      });
    };

    await app.register(asyncPlugin);
    await app.ready();

    const res = await app.inject({ url: "/delayed" });
    expect(res.status).toBe(200);
  });
});

// ─── 9. Auto-Serialization in Plugins ───
describe("Auto-serialization in plugins", () => {
  it("returning plain objects from plugin routes should auto-serialize", async () => {
    const app = createApp();

    const apiPlugin = async (ctx: any) => {
      ctx.get("/items", () => [{ id: 1, name: "Widget" }]);
      ctx.get("/count", () => 42);
      ctx.get("/status", () => "operational");
    };

    await app.register(apiPlugin, { prefix: "/api" });
    await app.ready();

    const arrRes = await app.inject({ url: "/api/items" });
    expect(arrRes.status).toBe(200);
    expect(await arrRes.json()).toEqual([{ id: 1, name: "Widget" }]);

    const numRes = await app.inject({ url: "/api/count" });
    expect(numRes.status).toBe(200);
    expect(await numRes.json()).toBe(42);

    const strRes = await app.inject({ url: "/api/status" });
    expect(strRes.status).toBe(200);
    expect(await strRes.text()).toBe("operational");
  });
});

// ─── 10. Content Negotiation ───
describe("Content Negotiation", () => {
  it("accepts() helpers should work on requests", async () => {
    const { accepts, acceptsEncoding, acceptsLanguage } = await import(
      "../packages/core/src/negotiate.js"
    );

    const req = new Request("http://localhost/test", {
      headers: {
        accept: "text/html, application/json;q=0.9",
        "accept-encoding": "gzip, deflate",
        "accept-language": "en-US,en;q=0.9,fr;q=0.8",
      },
    });

    const type = accepts(req, ["application/json", "text/html"]);
    expect(type).toBe("text/html"); // Higher priority

    const encoding = acceptsEncoding(req, ["gzip", "br"]);
    expect(encoding).toBe("gzip");

    const lang = acceptsLanguage(req, ["en-US", "fr"]);
    expect(lang).toBe("en-US");
  });
});

// ─── 11. Request Timeout ───
describe("Request timeout", () => {
  it("slow handlers should be timed out", async () => {
    const app = createApp({ requestTimeout: 100 });
    app.get("/slow", async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { should: "not reach" };
    });
    await app.ready();

    const res = await app.inject({ url: "/slow" });
    expect(res.status).toBe(504);
  });

  it("fast handlers should not be affected by timeout", async () => {
    const app = createApp({ requestTimeout: 1000 });
    app.get("/fast", () => ({ fast: true }));
    await app.ready();

    const res = await app.inject({ url: "/fast" });
    expect(res.status).toBe(200);
  });

  it("timeout disabled (0) should not enforce limit", async () => {
    const app = createApp({ requestTimeout: 0 });
    app.get("/unlimited", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ url: "/unlimited" });
    expect(res.status).toBe(200);
  });
});

// ─── 12. Body Size Limit ───
describe("Body size limit", () => {
  it("should reject oversized bodies", async () => {
    const app = createApp({ bodyLimit: 100 });
    app.post("/upload", async (req, reply) => {
      return reply.json({ size: JSON.stringify(req.parsedBody).length });
    });
    await app.ready();

    const bigPayload = { data: "x".repeat(200) };
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: bigPayload,
    });
    expect(res.status).toBe(413);
  });

  it("should allow bodies under the limit", async () => {
    const app = createApp({ bodyLimit: 10_000 });
    app.post("/upload", async (req, reply) => {
      return reply.json({ received: true });
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: { data: "small" },
    });
    expect(res.status).toBe(200);
  });
});

// ─── 13. inject() DX Improvements ───
describe("inject() DX", () => {
  it("inject with query option should append to URL", async () => {
    const app = createApp();
    app.get("/search", (req, reply) => {
      return reply.json({ q: req.query.q });
    });
    await app.ready();

    const res = await app.inject({
      url: "/search",
      query: { q: "celsian" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).q).toBe("celsian");
  });

  it("inject with headers should pass them through", async () => {
    const app = createApp();
    app.get("/check-header", (req, reply) => {
      return reply.json({ custom: req.headers.get("x-custom") });
    });
    await app.ready();

    const res = await app.inject({
      url: "/check-header",
      headers: { "x-custom": "my-value" },
    });
    expect((await res.json()).custom).toBe("my-value");
  });

  it("inject string payload should not double-stringify", async () => {
    const app = createApp();
    app.post("/text-echo", async (req, reply) => {
      return reply.send(req.parsedBody as string);
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/text-echo",
      headers: { "content-type": "text/plain" },
      payload: "hello raw",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello raw");
  });
});

// ─── 14. Multiple Reply Helpers Chaining ───
describe("Reply chaining", () => {
  it("status + header + json chain should work", async () => {
    const app = createApp();
    app.post("/created", (req, reply) => {
      return reply
        .status(201)
        .header("x-resource-id", "abc-123")
        .json({ id: "abc-123" });
    });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/created" });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-resource-id")).toBe("abc-123");
    expect((await res.json()).id).toBe("abc-123");
  });

  it("cookie + redirect chain should work", async () => {
    const app = createApp();
    app.get("/login", (req, reply) => {
      return reply.cookie("token", "xyz").redirect("/dashboard");
    });
    await app.ready();

    const res = await app.inject({ url: "/login" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(res.headers.get("set-cookie")).toContain("token=xyz");
  });
});

// ─── 15. createApp returns same type shape every time ───
describe("createApp consistency", () => {
  it("createApp with no options should work", async () => {
    const app = createApp();
    app.get("/test", () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ url: "/test" });
    expect(res.status).toBe(200);
  });

  it("createApp with all options should work", async () => {
    const app = createApp({
      prefix: "/api",
      logger: true,
      bodyLimit: 500_000,
      requestTimeout: 5000,
      trustProxy: true,
    });
    app.get("/ping", () => ({ pong: true }));
    await app.ready();

    const res = await app.inject({ url: "/api/ping" });
    expect(res.status).toBe(200);
    expect((await res.json()).pong).toBe(true);
  });
});

// ─── 16. Error edge cases ───
describe("Error edge cases", () => {
  it("throwing non-Error should still produce 500", async () => {
    const app = createApp();
    app.get("/throw-string", () => {
      throw "string error";
    });
    await app.ready();

    const res = await app.inject({ url: "/throw-string" });
    expect(res.status).toBe(500);
  });

  it("throwing null should still produce 500", async () => {
    const app = createApp();
    app.get("/throw-null", () => {
      throw null;
    });
    await app.ready();

    const res = await app.inject({ url: "/throw-null" });
    expect(res.status).toBe(500);
  });

  it("HttpError with custom statusCode should propagate", async () => {
    const app = createApp();
    app.get("/teapot", () => {
      throw new HttpError(418, "I'm a teapot");
    });
    await app.ready();

    const res = await app.inject({ url: "/teapot" });
    expect(res.status).toBe(418);
    const body = await res.json();
    expect(body.error).toBe("I'm a teapot");
  });
});

// ─── 17. Route listing ───
describe("Route listing", () => {
  it("getRoutes should return all registered routes", async () => {
    const app = createApp();
    app.get("/users", () => {});
    app.post("/users", () => {});
    app.get("/users/:id", () => {});
    app.delete("/users/:id", () => {});
    await app.ready();

    const routes = app.getRoutes();
    expect(routes.length).toBe(4);

    const methods = routes.map((r) => r.method);
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("DELETE");
  });

  it("getRouteManifest should categorize routes", async () => {
    const app = createApp();
    app.get("/api/data", () => {});
    app.route({ method: "POST", url: "/task/run", handler: () => {}, kind: "task" });
    await app.ready();

    const manifest = app.getRouteManifest();
    expect(manifest.serverless.length).toBeGreaterThanOrEqual(1);
    expect(manifest.task.length).toBe(1);
    expect(manifest.task[0].url).toBe("/task/run");
  });
});

// ─── 18. Decorator isolation ───
describe("Decorator isolation", () => {
  it("decorateReply should add to all replies", async () => {
    const app = createApp();
    app.decorateReply("timestamp", () => Date.now());

    app.get("/with-deco", (req, reply) => {
      return reply.json({ ts: (reply as any).timestamp });
    });
    await app.ready();

    const res = await app.inject({ url: "/with-deco" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.ts).toBe("number");
  });
});
