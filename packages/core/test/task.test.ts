import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Logger } from "../src/logger.js";
import { createLogger } from "../src/logger.js";
import { MemoryQueue, type QueueBackend, type QueueMessage } from "../src/queue.js";
import { TaskRegistry, TaskWorker } from "../src/task.js";

/** Collect structured log lines so tests can assert on what the worker logged. */
function createCapturingLogger(): { logger: Logger; lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const logger = createLogger({
    destination: (line: string) => {
      try {
        const parsed = JSON.parse(line);
        lines.push({ level: parsed.level, msg: parsed.msg });
      } catch {
        /* ignore */
      }
    },
  });
  return { logger, lines };
}

describe("Task System", () => {
  it("should register and enqueue tasks", async () => {
    const app = createApp();
    const results: string[] = [];

    app.task({
      name: "test-task",
      handler: async (input: { msg: string }) => {
        results.push(input.msg);
      },
    });

    const id = await app.enqueue("test-task", { msg: "hello" });
    expect(typeof id).toBe("string");
  });

  it("should throw on unknown task enqueue", async () => {
    const app = createApp();
    await expect(app.enqueue("nonexistent", {})).rejects.toThrow('Unknown task: "nonexistent"');
  });

  it("should process tasks via worker", async () => {
    const results: unknown[] = [];
    const logger = createLogger({ destination: () => {} });
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();

    registry.register({
      name: "process-me",
      handler: async (input) => {
        results.push(input);
      },
    });

    // Push a message directly
    await queue.push({
      id: "test-1",
      taskName: "process-me",
      input: { data: 42 },
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();

    // Wait for processing
    await new Promise((r) => setTimeout(r, 200));
    await worker.stop();

    expect(results).toEqual([{ data: 42 }]);
  });

  it("should retry failed tasks", async () => {
    let attempts = 0;
    const logger = createLogger({ destination: () => {} });
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();

    registry.register({
      name: "retry-me",
      retries: 2,
      handler: async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("fail");
        }
      },
    });

    await queue.push({
      id: "retry-1",
      taskName: "retry-me",
      input: {},
      attempt: 0,
      maxRetries: 2,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();

    // Exponential backoff: attempt 0 → 1s delay, attempt 1 → 2s delay
    // Need to wait long enough for all retries
    await new Promise((r) => setTimeout(r, 4000));
    await worker.stop();

    expect(attempts).toBe(3);
  });

  it("should respect task timeout", async () => {
    const logger = createLogger({ destination: () => {} });
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();
    let completed = false;

    registry.register({
      name: "slow-task",
      timeout: 50,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        completed = true;
      },
    });

    await queue.push({
      id: "timeout-1",
      taskName: "slow-task",
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();

    await new Promise((r) => setTimeout(r, 300));
    await worker.stop();

    expect(completed).toBe(false);
  });

  it("should integrate with app", async () => {
    const app = createApp();
    const processed: string[] = [];

    app.task({
      name: "email",
      handler: async (input: { to: string }) => {
        processed.push(input.to);
      },
    });

    await app.enqueue("email", { to: "user@example.com" });

    app.startWorker();
    await new Promise((r) => setTimeout(r, 200));
    await app.stopWorker();

    expect(processed).toContain("user@example.com");
  });

  it("keeps polling after queue.pop() rejects and processes the next message", async () => {
    // Regression: a rejected pop() used to escape tick()'s async body, so the
    // setTimeout that schedules the next tick was never reached and the worker
    // silently stopped. The worker must log the error and keep polling.
    const { logger, lines } = createCapturingLogger();
    const registry = new TaskRegistry();
    const processed: unknown[] = [];

    registry.register({
      name: "survivor",
      handler: async (input) => {
        processed.push(input);
      },
    });

    const inner = new MemoryQueue();
    await inner.push({
      id: "after-failure",
      taskName: "survivor",
      input: { ok: true },
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    let popCalls = 0;
    const flaky: QueueBackend = {
      push: (m: QueueMessage) => inner.push(m),
      pop: () => {
        popCalls++;
        if (popCalls === 1) {
          return Promise.reject(new Error("backend temporarily unavailable"));
        }
        return inner.pop();
      },
      ack: (id: string) => inner.ack(id),
      nack: (id: string, delay?: number) => inner.nack(id, delay),
      size: () => inner.size(),
    };

    const worker = new TaskWorker(registry, flaky, logger, { pollInterval: 20 });
    worker.start();

    await new Promise((r) => setTimeout(r, 200));
    await worker.stop();

    // The error was logged...
    expect(lines.some((l) => l.level === "error" && l.msg === "Task worker poll failed")).toBe(true);
    // ...and the worker kept polling and processed the next message.
    expect(processed).toEqual([{ ok: true }]);
    expect(popCalls).toBeGreaterThan(1);
  });

  it("does not crash when ack() rejects; logs and continues", async () => {
    // Regression: an ack() rejection in processMessage was unguarded and would
    // surface as an unhandled rejection. It must be logged instead.
    const { logger, lines } = createCapturingLogger();
    const registry = new TaskRegistry();

    registry.register({
      name: "ack-fails",
      handler: async () => {
        /* succeeds */
      },
    });

    const inner = new MemoryQueue();
    await inner.push({
      id: "ack-1",
      taskName: "ack-fails",
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    let ackCalled = false;
    const queue: QueueBackend = {
      push: (m: QueueMessage) => inner.push(m),
      pop: () => inner.pop(),
      ack: () => {
        ackCalled = true;
        return Promise.reject(new Error("ack backend down"));
      },
      nack: (id: string, delay?: number) => inner.nack(id, delay),
      size: () => inner.size(),
    };

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 20 });
    worker.start();

    await new Promise((r) => setTimeout(r, 150));
    await worker.stop();

    expect(ackCalled).toBe(true);
    expect(lines.some((l) => l.level === "error" && l.msg === "Failed to ack queue message")).toBe(true);
  });
});
