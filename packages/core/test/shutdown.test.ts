// @celsian/core — Graceful shutdown tests for CronScheduler and TaskWorker

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CronScheduler, parseCronExpression, shouldRun } from "../src/cron.js";
import { createLogger } from "../src/logger.js";
import { MemoryQueue } from "../src/queue.js";
import { TaskRegistry, TaskWorker } from "../src/task.js";

// ─── CronScheduler shutdown ───

describe("CronScheduler shutdown", () => {
  it("stop() clears the interval timer", () => {
    const scheduler = new CronScheduler();
    scheduler.add({
      name: "tick-job",
      schedule: "* * * * *",
      handler: () => {},
    });

    scheduler.start();
    // After start, the scheduler should be ticking.
    // stop() should clear the timer without throwing.
    scheduler.stop();

    // Calling stop again should be safe (idempotent)
    expect(() => scheduler.stop()).not.toThrow();
  });

  it("start() is idempotent — calling twice does not create duplicate timers", () => {
    const scheduler = new CronScheduler();
    scheduler.add({
      name: "dup-check",
      schedule: "* * * * *",
      handler: () => {},
    });

    scheduler.start();
    scheduler.start(); // Second call should be a no-op
    scheduler.stop();
  });

  it("stop() then start() restarts the scheduler", () => {
    const scheduler = new CronScheduler();
    scheduler.add({
      name: "restart-job",
      schedule: "* * * * *",
      handler: () => {},
    });

    scheduler.start();
    scheduler.stop();

    // Should be able to restart after stopping
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it("stop() without start() does not throw", () => {
    const scheduler = new CronScheduler();
    expect(() => scheduler.stop()).not.toThrow();
  });

  it("scheduler can add jobs before and after start", () => {
    const scheduler = new CronScheduler();

    scheduler.add({
      name: "before-start",
      schedule: "0 * * * *",
      handler: () => {},
    });

    scheduler.start();

    scheduler.add({
      name: "after-start",
      schedule: "30 * * * *",
      handler: () => {},
    });

    const jobs = scheduler.getJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].name).toBe("before-start");
    expect(jobs[1].name).toBe("after-start");

    scheduler.stop();
  });

  it("start/stop/start cycle does not leak timers", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const scheduler = new CronScheduler();
    scheduler.add({
      name: "leak-test",
      schedule: "* * * * *",
      handler: () => {},
    });

    scheduler.start();
    scheduler.stop();
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockClear();

    scheduler.start();
    scheduler.stop();
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });
});

// ─── TaskWorker shutdown ───

describe("TaskWorker shutdown", () => {
  function createSilentLogger() {
    return createLogger({ destination: () => {} });
  }

  it("stop() resolves immediately when no active jobs", async () => {
    const logger = createSilentLogger();
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();

    // Stop immediately — no jobs were enqueued
    await worker.stop();
    // If we get here, stop resolved successfully
  });

  it("stop() waits for an active job to finish before resolving", async () => {
    const logger = createSilentLogger();
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();
    let jobFinished = false;

    registry.register({
      name: "slow-job",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 200));
        jobFinished = true;
      },
    });

    await queue.push({
      id: "stop-wait-1",
      taskName: "slow-job",
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();

    // Give the worker a moment to pick up the job
    await new Promise((r) => setTimeout(r, 100));

    // stop() should wait for the active job to finish
    await worker.stop();
    expect(jobFinished).toBe(true);
  });

  it("stop() prevents new jobs from being picked up", async () => {
    const logger = createSilentLogger();
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();
    const processed: string[] = [];

    registry.register({
      name: "track-job",
      handler: async (input: { id: string }) => {
        processed.push(input.id);
      },
    });

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();

    // Stop the worker before adding any jobs
    await worker.stop();

    // Now add a job — it should NOT be processed since the worker is stopped
    await queue.push({
      id: "after-stop-1",
      taskName: "track-job",
      input: { id: "should-not-run" },
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(processed).not.toContain("should-not-run");
  });

  it("start() is idempotent", async () => {
    const logger = createSilentLogger();
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();
    worker.start(); // Second call should be no-op
    await worker.stop();
  });

  it("start/stop/start lifecycle works", async () => {
    const logger = createSilentLogger();
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();
    const processed: string[] = [];

    registry.register({
      name: "lifecycle-job",
      handler: async (input: { id: string }) => {
        processed.push(input.id);
      },
    });

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });

    // First cycle
    worker.start();
    await queue.push({
      id: "cycle-1",
      taskName: "lifecycle-job",
      input: { id: "first" },
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 200));
    await worker.stop();

    expect(processed).toContain("first");

    // Second cycle — restart the worker
    worker.start();
    await queue.push({
      id: "cycle-2",
      taskName: "lifecycle-job",
      input: { id: "second" },
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 200));
    await worker.stop();

    expect(processed).toContain("second");
  });

  it("stop clears the poll timer", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const logger = createSilentLogger();
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 100 });
    worker.start();

    // Give the poll timer a chance to be set
    await new Promise((r) => setTimeout(r, 150));

    await worker.stop();
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });
});

// ─── App-level shutdown integration ───

describe("App-level shutdown integration", () => {
  it("app.stopWorker() resolves when no worker was started", async () => {
    const app = createApp();
    // stopWorker before startWorker should be safe
    await app.stopWorker();
  });

  it("app.stopCron() is safe without prior startCron()", () => {
    const app = createApp();
    expect(() => app.stopCron()).not.toThrow();
  });

  it("app start/stop worker lifecycle works end-to-end", async () => {
    const app = createApp();
    const processed: string[] = [];

    app.task({
      name: "shutdown-test-task",
      handler: async (input: { msg: string }) => {
        processed.push(input.msg);
      },
    });

    await app.enqueue("shutdown-test-task", { msg: "hello" });

    app.startWorker();
    await new Promise((r) => setTimeout(r, 200));
    await app.stopWorker();

    expect(processed).toContain("hello");
  });

  it("app start/stop cron lifecycle works end-to-end", () => {
    const app = createApp();
    let called = false;

    app.cron("shutdown-cron", "* * * * *", () => {
      called = true;
    });

    app.startCron();
    app.stopCron();

    const jobs = app.getCronJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("shutdown-cron");
  });

  it("startWorker is idempotent on the app", async () => {
    const app = createApp();

    app.task({
      name: "idem-task",
      handler: async () => {},
    });

    app.startWorker();
    app.startWorker(); // should not create a second worker
    await app.stopWorker();
  });
});
