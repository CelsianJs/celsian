// @celsian/core, Task system: define background tasks, enqueue, and process

import { CelsianError } from "./errors.js";
import type { Logger } from "./logger.js";
import {
  DEFAULT_VISIBILITY_TIMEOUT,
  type DeadLetterEntry,
  generateQueueId,
  type QueueBackend,
  type QueueMessage,
  type TaskFailure,
} from "./queue.js";

/**
 * Default execution timeout applied to every task that does not set its own.
 *
 * Deliberately below the default queue visibility timeout: a task that outran
 * its lease would be redelivered and run concurrently with itself, so an
 * unbounded default is a correctness bug, not a convenience.
 */
export const DEFAULT_TASK_TIMEOUT = 25_000;

/** Definition for a background task: name, handler, optional retries and timeout. */
export interface TaskDefinition<TInput = unknown> {
  name: string;
  handler: (input: TInput, ctx: TaskContext) => Promise<void>;
  retries?: number;
  /**
   * Execution timeout in ms. Defaults to {@link DEFAULT_TASK_TIMEOUT}, clamped
   * below the queue's visibility timeout. Must stay below the visibility
   * timeout unless `longRunning` is set.
   */
  timeout?: number;
  /**
   * Opt in to a timeout at or above the queue's visibility timeout. Only safe
   * when the backend supports heartbeats (`queue.extend`) *and* the handler
   * yields to the event loop often enough for the worker's automatic heartbeat
   * to fire. A handler that blocks the event loop will still lose its lease and
   * be executed twice.
   */
  longRunning?: boolean;
}

/** Context passed to a task handler: task ID, current attempt number, and a child logger. */
export interface TaskContext {
  taskId: string;
  attempt: number;
  log: Logger;
  /** How many times this message has been delivered, including redeliveries after a lease expiry. */
  deliveries: number;
  /** Failures recorded on previous attempts, oldest first. */
  failures: TaskFailure[];
  /**
   * Aborted when the task exceeds its timeout or the worker is shutting down.
   * Long-running handlers should pass it to `fetch`, stream reads, and any
   * other cancellable work, and check `signal.aborted` between steps.
   */
  signal: AbortSignal;
  /**
   * Manually extend this delivery's lease. The worker already heartbeats
   * automatically; call this from inside a long synchronous-ish stretch to push
   * the lease out explicitly. Resolves false when the lease is already lost,
   * meaning another worker may now own the message.
   */
  heartbeat(extraMs?: number): Promise<boolean>;
}

/** Details of a single failed attempt, passed to the `onFailure` hook. */
export interface TaskFailureInfo {
  message: QueueMessage;
  error: Error;
  /** Every failure recorded so far, including this one. */
  failures: TaskFailure[];
  /** Whether the worker is going to retry the job. */
  willRetry: boolean;
  /** Delay before the retry, when `willRetry` is true. */
  retryDelay?: number;
}

/** Registry mapping task names to their definitions. */
export class TaskRegistry {
  private tasks = new Map<string, TaskDefinition>();
  private visibilityTimeout: number | undefined;
  private backendCanHeartbeat = false;

  /**
   * Tell the registry about the queue it will be drained by, so task timeouts
   * can be validated at registration time. Called by {@link TaskWorker}; also
   * re-validates everything already registered.
   */
  setQueueConstraints(visibilityTimeout: number | undefined, canHeartbeat: boolean): void {
    this.visibilityTimeout = visibilityTimeout;
    this.backendCanHeartbeat = canHeartbeat;
    for (const definition of this.tasks.values()) {
      this.assertTimeoutIsSafe(definition);
    }
  }

  register<TInput>(definition: TaskDefinition<TInput>): void {
    this.assertTimeoutIsSafe(definition as TaskDefinition);
    this.tasks.set(definition.name, definition as TaskDefinition);
  }

  get(name: string): TaskDefinition | undefined {
    return this.tasks.get(name);
  }

  has(name: string): boolean {
    return this.tasks.has(name);
  }

  /** All registered task definitions. */
  list(): TaskDefinition[] {
    return [...this.tasks.values()];
  }

  /**
   * Reject a configured timeout that would let a task outlive its queue lease,
   * because that guarantees the message is redelivered while it is still
   * running, i.e. duplicate concurrent execution of the same job.
   */
  private assertTimeoutIsSafe(definition: TaskDefinition): void {
    const visibility = this.visibilityTimeout;
    if (visibility === undefined || definition.timeout === undefined) return;
    if (definition.timeout < visibility) return;

    if (!definition.longRunning) {
      throw new CelsianError(
        `Task "${definition.name}" has timeout ${definition.timeout}ms, which is not below the queue's visibility timeout of ${visibility}ms. ` +
          "A task that outlives its lease is redelivered and runs concurrently with itself. " +
          `Fix this by lowering the task timeout below ${visibility}ms, raising the backend's visibilityTimeout above ${definition.timeout}ms, ` +
          "or setting longRunning: true if the handler yields to the event loop so the worker can heartbeat the lease.",
      );
    }
    if (!this.backendCanHeartbeat) {
      throw new CelsianError(
        `Task "${definition.name}" sets longRunning: true, but the configured queue backend does not implement extend() so its lease cannot be heartbeated. ` +
          `Lower the task timeout below the visibility timeout (${visibility}ms) or use a backend with heartbeat support.`,
      );
    }
  }
}

/** Configuration for the task worker: concurrency, poll interval, and failure hooks. */
export interface TaskWorkerOptions {
  concurrency?: number;
  pollInterval?: number;
  /** Called after every failed attempt, whether or not it will be retried. */
  onFailure?: (info: TaskFailureInfo) => void | Promise<void>;
  /** Called when a job exhausts its retries and is moved to the dead-letter queue. */
  onDeadLetter?: (entry: DeadLetterEntry) => void | Promise<void>;
}

/**
 * Background worker that polls the queue and executes tasks with retry logic.
 * Supports configurable concurrency and exponential backoff on failure.
 *
 * Jobs that exhaust their retries are moved to the backend's dead-letter queue
 * (never silently discarded) and reported through `onDeadLetter`.
 */
export class TaskWorker {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeJobs = 0;
  private activeControllers = new Set<AbortController>();
  private readonly concurrency: number;
  private readonly pollInterval: number;
  private readonly onFailure?: (info: TaskFailureInfo) => void | Promise<void>;
  private readonly onDeadLetter?: (entry: DeadLetterEntry) => void | Promise<void>;
  private readonly visibilityTimeout: number;
  private readonly canHeartbeat: boolean;

  constructor(
    private registry: TaskRegistry,
    private queue: QueueBackend,
    private log: Logger,
    options: TaskWorkerOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 1;
    this.pollInterval = options.pollInterval ?? 1000;
    this.onFailure = options.onFailure;
    this.onDeadLetter = options.onDeadLetter;
    this.visibilityTimeout = queue.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT;
    this.canHeartbeat = typeof queue.extend === "function";
    // Validates every already-registered task against this backend's lease
    // window, and every task registered from here on.
    this.registry.setQueueConstraints(queue.visibilityTimeoutMs, this.canHeartbeat);

    if (typeof queue.deadLetter !== "function") {
      this.log.warn(
        "Queue backend has no dead-letter support; permanently failed jobs will be dropped after their retries are exhausted",
      );
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.poll();
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.running = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for active jobs with deadline
    const deadline = Date.now() + timeoutMs;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (this.activeJobs > 0) {
      const abandoned = this.activeJobs;
      // Give handlers that honour the signal a chance to bail out so their
      // messages are nacked back onto the queue instead of being abandoned
      // mid-flight.
      for (const controller of this.activeControllers) {
        controller.abort(new CelsianError("Task worker is shutting down"));
      }
      const detail =
        `[celsian] Task worker shutdown deadline of ${timeoutMs}ms elapsed with ${abandoned} job(s) still running. ` +
        "Those jobs were NOT completed and were NOT acked. On a durable backend they are redelivered once their " +
        "visibility timeout expires; on the in-memory backend they are LOST when this process exits. " +
        "Increase the shutdown timeout, lower task durations, or use a durable backend such as @celsian/queue-redis.";
      this.log.error("Task worker abandoned running jobs at shutdown", {
        abandonedJobs: abandoned,
        shutdownTimeoutMs: timeoutMs,
      });
      // Also emit outside the structured logger: shutdown is exactly when a noop
      // or already-closed logger would swallow the one message that matters.
      console.error(detail);
    }
  }

  private poll(): void {
    if (!this.running) return;

    const tick = async () => {
      if (!this.running) return;

      try {
        while (this.activeJobs < this.concurrency && this.running) {
          const message = await this.queue.pop();
          if (!message) break;
          this.activeJobs++;
          this.processMessage(message).finally(() => {
            this.activeJobs--;
          });
        }
      } catch (error) {
        // A rejected pop() (e.g. queue backend is temporarily unavailable) must
        // not silently stop polling. Log and let the next tick be scheduled.
        this.log.error("Task worker poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (this.running) {
        // Replace previous timer reference to prevent unbounded growth
        this.pollTimer = setTimeout(() => tick(), this.pollInterval);
      }
    };

    tick();
  }

  private async processMessage(message: QueueMessage): Promise<void> {
    const leaseToken = message.leaseToken;
    const definition = this.registry.get(message.taskName);
    if (!definition) {
      this.log.error("Unknown task", { taskName: message.taskName });
      // An unregistered task is a permanent failure, not something to discard:
      // it is usually a deploy that removed a task still present in the queue.
      await this.failPermanently(message, leaseToken, new CelsianError(`Unknown task: "${message.taskName}"`), []);
      return;
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);

    const ctx: TaskContext = {
      taskId: message.id,
      attempt: message.attempt,
      deliveries: message.deliveries ?? 1,
      failures: message.failures ?? [],
      signal: controller.signal,
      log: this.log.child({ taskId: message.id, taskName: message.taskName }),
      heartbeat: (extraMs?: number) => this.heartbeat(message, leaseToken, extraMs),
    };

    const timeout = this.resolveTimeout(definition);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const heartbeatTimer = this.startHeartbeat(message, leaseToken);

    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          // Abort so the handler can actually stop, rather than merely losing
          // the race and continuing to run alongside a retry of itself.
          controller.abort(new CelsianError(`Task "${message.taskName}" timed out after ${timeout}ms`));
          reject(new CelsianError(`Task "${message.taskName}" timed out after ${timeout}ms`));
        }, timeout);
        definition.handler(message.input, ctx).then(resolve, reject);
      });
      await this.safeAck(message.id, leaseToken);
    } catch (error) {
      await this.handleFailure(message, leaseToken, definition, error, ctx);
    } finally {
      // Always clear the timer: a task with a one-hour timeout that finishes in
      // 1ms must not keep an armed hour-long timer alive.
      if (timer !== null) clearTimeout(timer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      this.activeControllers.delete(controller);
    }
  }

  /** Effective timeout for a task, clamped under the backend's visibility timeout. */
  private resolveTimeout(definition: TaskDefinition): number {
    if (definition.timeout !== undefined) return definition.timeout;
    // Leave headroom so an unconfigured task can never outlive its own lease.
    return Math.max(1, Math.min(DEFAULT_TASK_TIMEOUT, Math.floor(this.visibilityTimeout * 0.8)));
  }

  /**
   * Periodically push the lease out while a task runs, so a long task keeps
   * ownership of its message instead of being reclaimed and run twice.
   */
  private startHeartbeat(message: QueueMessage, leaseToken?: string): ReturnType<typeof setInterval> | null {
    if (!this.canHeartbeat || !leaseToken) return null;
    const interval = Math.max(250, Math.floor(this.visibilityTimeout / 3));
    const timer = setInterval(() => {
      void this.heartbeat(message, leaseToken);
    }, interval);
    timer.unref?.();
    return timer;
  }

  private async heartbeat(message: QueueMessage, leaseToken?: string, extraMs?: number): Promise<boolean> {
    if (!this.queue.extend || !leaseToken) return false;
    try {
      const held = await this.queue.extend(message.id, leaseToken, extraMs);
      if (!held) {
        this.log.warn("Task lease lost; another worker may now own this job", {
          taskId: message.id,
          taskName: message.taskName,
        });
      }
      return held;
    } catch (error) {
      this.log.error("Failed to extend task lease", {
        taskId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async handleFailure(
    message: QueueMessage,
    leaseToken: string | undefined,
    definition: TaskDefinition,
    error: unknown,
    ctx: TaskContext,
  ): Promise<void> {
    const err = error instanceof Error ? error : new CelsianError(String(error));
    const retries = definition.retries ?? 0;
    const failure: TaskFailure = { attempt: message.attempt, error: err.message, failedAt: Date.now() };
    const failures = [...(message.failures ?? []), failure];
    const willRetry = message.attempt < retries;
    const retryDelay = willRetry ? Math.min(1000 * 2 ** message.attempt, 30000) : undefined;

    await this.emit("onFailure", () => this.onFailure?.({ message, error: err, failures, willRetry, retryDelay }));

    if (willRetry) {
      ctx.log.warn("Task failed, retrying", {
        attempt: message.attempt,
        maxRetries: retries,
        error: err.message,
      });
      await this.safeNack(message.id, retryDelay ?? 1000, leaseToken, failure);
      return;
    }

    ctx.log.error("Task failed permanently", { attempt: message.attempt, error: err.message });
    await this.failPermanently(message, leaseToken, err, failures);
  }

  /**
   * Route a permanently-failed job to the dead-letter queue. Only when the
   * backend has no DLQ at all does the job get acked away, and then loudly.
   */
  private async failPermanently(
    message: QueueMessage,
    leaseToken: string | undefined,
    error: Error,
    failures: TaskFailure[],
  ): Promise<void> {
    const entry: DeadLetterEntry = {
      message: { ...message, failures },
      error: error.message,
      failures,
      deadLetteredAt: Date.now(),
    };

    if (typeof this.queue.deadLetter === "function") {
      try {
        await this.queue.deadLetter(entry, leaseToken);
        this.log.error("Task dead-lettered", {
          taskId: message.id,
          taskName: message.taskName,
          attempts: failures.length,
          error: error.message,
        });
        await this.emit("onDeadLetter", () => this.onDeadLetter?.(entry));
        return;
      } catch (dlqError) {
        this.log.error("Failed to dead-letter task; leaving it in-flight for redelivery", {
          taskId: message.id,
          error: dlqError instanceof Error ? dlqError.message : String(dlqError),
        });
        // Deliberately do NOT ack: leaving the message in-flight means the
        // backend's visibility timeout will redeliver it rather than destroy it.
        return;
      }
    }

    this.log.error("Discarding permanently failed task: queue backend has no dead-letter queue", {
      taskId: message.id,
      taskName: message.taskName,
      error: error.message,
    });
    await this.emit("onDeadLetter", () => this.onDeadLetter?.(entry));
    await this.safeAck(message.id, leaseToken);
  }

  /** Run a user hook without letting it take down the worker. */
  private async emit(name: string, fn: () => void | Promise<void> | undefined): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.log.error(`Task worker ${name} hook threw`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Ack a message, swallowing (but logging) backend rejections so a transient
   * queue failure never propagates up and stops the worker loop.
   */
  private async safeAck(id: string, leaseToken?: string): Promise<void> {
    try {
      await this.queue.ack(id, leaseToken);
    } catch (error) {
      this.log.error("Failed to ack queue message", {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Nack a message, swallowing (but logging) backend rejections. A failed nack
   * leaves the message in-flight to be reclaimed by the backend's visibility
   * timeout rather than crashing the worker.
   */
  private async safeNack(id: string, delay: number, leaseToken?: string, failure?: TaskFailure): Promise<void> {
    try {
      await this.queue.nack(id, delay, leaseToken, failure);
    } catch (error) {
      this.log.error("Failed to nack queue message", {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Create an enqueue function bound to a queue backend and task registry. */
export function createEnqueue(queue: QueueBackend, registry: TaskRegistry) {
  return async function enqueue(taskName: string, input: unknown): Promise<string> {
    if (!registry.has(taskName)) {
      throw new CelsianError(`Unknown task: "${taskName}". Register it with taskRegistry.register() before enqueuing.`);
    }
    const definition = registry.get(taskName)!;
    const id = generateQueueId();
    const message: QueueMessage = {
      id,
      taskName,
      input,
      attempt: 0,
      maxRetries: definition.retries ?? 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
      deliveries: 0,
      failures: [],
    };
    await queue.push(message);
    return id;
  };
}
