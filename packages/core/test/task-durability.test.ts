// @celsian/core, TaskWorker dead-lettering, timeout cancellation and lease handling

import { describe, expect, it, vi } from "vitest";
import { CelsianError } from "../src/errors.js";
import { createLogger, type Logger } from "../src/logger.js";
import { type DeadLetterEntry, MemoryQueue, type QueueMessage } from "../src/queue.js";
import { type TaskFailureInfo, TaskRegistry, TaskWorker } from "../src/task.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const silentLogger = (): Logger => createLogger({ destination: () => {} });

function push(queue: MemoryQueue, taskName: string, overrides: Partial<QueueMessage> = {}) {
  return queue.push({
    id: overrides.id ?? "job-1",
    taskName,
    input: {},
    attempt: 0,
    maxRetries: 0,
    createdAt: Date.now(),
    availableAt: Date.now(),
    deliveries: 0,
    failures: [],
    ...overrides,
  });
}

/** Run a worker until `predicate` holds, then stop it. */
async function runUntil(
  worker: TaskWorker,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  worker.start();
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) await sleep(10);
  await worker.stop(500);
}

/** True once the queue has at least one dead-lettered job. */
const hasDeadLetter = (queue: MemoryQueue) => async () => (await queue.deadLetterSize()) > 0;

describe("TaskWorker dead-letter queue", () => {
  it("dead-letters a job that exhausts its retries instead of destroying it", async () => {
    // Regression: the worker logged "Task failed permanently" and then ACKED the
    // job, so an unrecoverable failure left no artifact anywhere.
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();
    registry.register({
      name: "always-fails",
      retries: 1,
      handler: async () => {
        throw new CelsianError("nope");
      },
    });
    await push(queue, "always-fails", { maxRetries: 1 });

    const worker = new TaskWorker(registry, queue, silentLogger(), { pollInterval: 10 });
    // The retry backoff is 1s, so the second attempt lands a second later.
    await runUntil(worker, hasDeadLetter(queue), 6000);

    expect(await queue.deadLetterSize()).toBe(1);
    const [entry] = await queue.listDeadLetters();
    expect(entry?.message.taskName).toBe("always-fails");
    expect(entry?.error).toBe("nope");
    // The full attempt history is preserved, not just the last error.
    expect(entry?.failures.length).toBe(2);
    expect(entry?.failures.map((f) => f.attempt)).toEqual([0, 1]);
  });

  it("fires onFailure for every attempt and onDeadLetter once at the end", async () => {
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();
    registry.register({
      name: "hooked",
      retries: 0,
      handler: async () => {
        throw new CelsianError("kaboom");
      },
    });
    await push(queue, "hooked");

    const failures: TaskFailureInfo[] = [];
    const dead: DeadLetterEntry[] = [];
    const worker = new TaskWorker(registry, queue, silentLogger(), {
      pollInterval: 10,
      onFailure: (info) => {
        failures.push(info);
      },
      onDeadLetter: (entry) => {
        dead.push(entry);
      },
    });

    await runUntil(worker, () => dead.length > 0);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.error.message).toBe("kaboom");
    expect(failures[0]?.willRetry).toBe(false);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.message.id).toBe("job-1");
    expect(dead[0]?.error).toBe("kaboom");
    expect(dead[0]?.failures).toHaveLength(1);
  });

  it("a throwing onDeadLetter hook does not take down the worker", async () => {
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();
    registry.register({
      name: "hook-throws",
      handler: async () => {
        throw new CelsianError("x");
      },
    });
    await push(queue, "hook-throws");

    const worker = new TaskWorker(registry, queue, silentLogger(), {
      pollInterval: 10,
      onDeadLetter: () => {
        throw new CelsianError("hook exploded");
      },
    });
    await runUntil(worker, hasDeadLetter(queue));
    // The worker survived and still dead-lettered the job.
    expect(await queue.deadLetterSize()).toBe(1);
  });

  it("dead-letters a job whose task is no longer registered", async () => {
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();
    await push(queue, "removed-in-a-deploy");

    const worker = new TaskWorker(registry, queue, silentLogger(), { pollInterval: 10 });
    await runUntil(worker, hasDeadLetter(queue));

    expect(await queue.deadLetterSize()).toBe(1);
    const [entry] = await queue.listDeadLetters();
    expect(entry?.error).toContain("Unknown task");
  });

  it("warns when the backend cannot dead-letter, and still does not lose the job silently", async () => {
    const inner = new MemoryQueue();
    await push(inner, "doomed");
    const logged: Array<{ level: string; msg: string }> = [];
    const logger = createLogger({
      destination: (line) => logged.push(JSON.parse(line)),
    });

    // A third-party backend predating the dead-letter API.
    const legacy = {
      push: (m: QueueMessage) => inner.push(m),
      pop: () => inner.pop(),
      ack: (id: string, token?: string) => inner.ack(id, token),
      nack: (id: string, delay?: number, token?: string) => inner.nack(id, delay, token),
      size: () => inner.size(),
    };

    const registry = new TaskRegistry();
    registry.register({
      name: "doomed",
      handler: async () => {
        throw new CelsianError("bang");
      },
    });

    const worker = new TaskWorker(registry, legacy, logger, { pollInterval: 10 });
    expect(logged.some((l) => l.msg.includes("no dead-letter support"))).toBe(true);

    await runUntil(worker, () => logged.some((l) => l.msg.includes("Discarding permanently failed task")));
    expect(logged.some((l) => l.level === "error" && l.msg.includes("Discarding permanently failed task"))).toBe(true);
  });
});

describe("TaskWorker timeouts", () => {
  it("clears the timeout timer when the task finishes quickly", async () => {
    // Regression: the timer was never cleared, so a task configured with a
    // one-hour timeout kept an armed one-hour timer after finishing in 1ms.
    const queue = new MemoryQueue({ visibilityTimeout: 3_700_000 });
    const registry = new TaskRegistry();
    registry.register({
      name: "fast",
      timeout: 3_600_000,
      handler: async () => {},
    });
    await push(queue, "fast");

    const armed = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const handle = (realSetTimeout as typeof setTimeout)(fn, ms, ...rest);
      if (ms === 3_600_000) armed.add(handle);
      return handle;
    }) as typeof setTimeout);
    const cleared = new Set<unknown>();
    const realClearTimeout = globalThis.clearTimeout;
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle: unknown) => {
      cleared.add(handle);
      return (realClearTimeout as unknown as (h: unknown) => void)(handle);
    }) as typeof clearTimeout);

    try {
      const worker = new TaskWorker(registry, queue, silentLogger(), { pollInterval: 10 });
      await runUntil(worker, async () => (await queue.inFlightSize()) === 0 && (await queue.size()) === 0);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }

    expect(armed.size).toBe(1);
    for (const handle of armed) expect(cleared.has(handle)).toBe(true);
  });

  it("aborts the handler's signal on timeout instead of letting it run on", async () => {
    // Regression: the timeout only won a Promise.race, the handler kept
    // running while the worker nacked the job for a retry, so the task
    // executed concurrently with itself.
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();
    let aborted = false;
    let reason = "";
    registry.register({
      name: "cancellable",
      timeout: 50,
      handler: async (_input, ctx) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          reason = (ctx.signal.reason as Error)?.message ?? "";
        });
        await sleep(3000);
      },
    });
    await push(queue, "cancellable");

    const worker = new TaskWorker(registry, queue, silentLogger(), { pollInterval: 10 });
    await runUntil(worker, () => aborted);

    expect(aborted).toBe(true);
    expect(reason).toContain("timed out after 50ms");
  });

  it("applies a default timeout below the visibility timeout when none is configured", async () => {
    // Regression: with no default timeout, a task with no `timeout` could run
    // past its lease and be redelivered while still running.
    const queue = new MemoryQueue({ visibilityTimeout: 200 });
    const registry = new TaskRegistry();
    let finished = false;
    registry.register({
      name: "unbounded",
      handler: async () => {
        await sleep(2000);
        finished = true;
      },
    });
    await push(queue, "unbounded");

    const worker = new TaskWorker(registry, queue, silentLogger(), { pollInterval: 10 });
    // Effective timeout is 80% of the 200ms visibility window.
    await runUntil(worker, hasDeadLetter(queue), 2000);

    expect(finished).toBe(false);
    const [entry] = await queue.listDeadLetters();
    expect(entry?.error).toContain("timed out after 160ms");
  });

  it("rejects a task whose timeout is not below the queue's visibility timeout", () => {
    const queue = new MemoryQueue({ visibilityTimeout: 30_000 });
    const registry = new TaskRegistry();
    registry.register({
      name: "too-long",
      timeout: 60_000,
      handler: async () => {},
    });

    expect(() => new TaskWorker(registry, queue, silentLogger())).toThrow(
      /timeout 60000ms, which is not below the queue's visibility timeout of 30000ms/,
    );
    // The message must say what to actually do about it.
    expect(() => new TaskWorker(registry, queue, silentLogger())).toThrow(/longRunning: true/);
  });

  it("rejects a task registered after the worker with an unsafe timeout", () => {
    const queue = new MemoryQueue({ visibilityTimeout: 5_000 });
    const registry = new TaskRegistry();
    new TaskWorker(registry, queue, silentLogger());

    expect(() => registry.register({ name: "late", timeout: 10_000, handler: async () => {} })).toThrow(
      /not below the queue's visibility timeout of 5000ms/,
    );
  });

  it("allows an explicitly long-running task on a backend that supports heartbeats", () => {
    const queue = new MemoryQueue({ visibilityTimeout: 5_000 });
    const registry = new TaskRegistry();
    registry.register({ name: "batch", timeout: 60_000, longRunning: true, handler: async () => {} });
    expect(() => new TaskWorker(registry, queue, silentLogger())).not.toThrow();
  });

  it("rejects longRunning when the backend has no heartbeat support", () => {
    const inner = new MemoryQueue({ visibilityTimeout: 5_000 });
    const noHeartbeat = {
      push: (m: QueueMessage) => inner.push(m),
      pop: () => inner.pop(),
      ack: (id: string) => inner.ack(id),
      nack: (id: string, delay?: number) => inner.nack(id, delay),
      size: () => inner.size(),
      visibilityTimeoutMs: 5_000,
    };
    const registry = new TaskRegistry();
    registry.register({ name: "batch", timeout: 60_000, longRunning: true, handler: async () => {} });

    expect(() => new TaskWorker(registry, noHeartbeat, silentLogger())).toThrow(/does not implement extend\(\)/);
  });
});

describe("TaskWorker lease heartbeat", () => {
  it("keeps a long task's lease alive so it is never run concurrently with itself", async () => {
    // Two workers share one queue. Without heartbeats the first worker's lease
    // expires mid-task and the second worker picks the same job up.
    const queue = new MemoryQueue({ visibilityTimeout: 120 });
    const registry = new TaskRegistry();
    let starts = 0;
    registry.register({
      name: "slow-but-alive",
      timeout: 95,
      longRunning: false,
      handler: async () => {
        starts++;
        await sleep(400);
      },
    });
    await push(queue, "slow-but-alive", { maxRetries: 5 });

    const a = new TaskWorker(registry, queue, silentLogger(), { pollInterval: 10 });
    const b = new TaskWorker(registry, queue, silentLogger(), { pollInterval: 10 });
    a.start();
    b.start();
    await sleep(300);
    await Promise.all([a.stop(50), b.stop(50)]);

    // The heartbeat holds the lease, so the job is delivered exactly once even
    // though it outlives a single visibility window.
    expect(starts).toBe(1);
  });

  it("ctx.heartbeat() reports a lost lease", async () => {
    // Visibility (50ms) is shorter than the automatic heartbeat interval, so
    // this delivery's lease really does expire mid-handler.
    const queue = new MemoryQueue({ visibilityTimeout: 50 });
    const registry = new TaskRegistry();
    let held: boolean | null = null;
    registry.register({
      name: "checks-lease",
      timeout: 45,
      handler: async (_input, ctx) => {
        await sleep(120);
        // Another consumer polls, which reclaims the expired lease and takes
        // the message over under a new token.
        await queue.pop();
        held = await ctx.heartbeat();
      },
    });
    await push(queue, "checks-lease", { maxRetries: 5 });

    const worker = new TaskWorker(registry, queue, silentLogger(), { pollInterval: 10 });
    await runUntil(worker, () => held !== null);
    expect(held).toBe(false);
  });
});
