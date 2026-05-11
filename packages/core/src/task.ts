// @celsian/core — Task system: define background tasks, enqueue, and process

import { CelsianError } from "./errors.js";
import type { Logger } from "./logger.js";
import { generateQueueId, type QueueBackend, type QueueMessage } from "./queue.js";

/** Definition for a background task: name, handler, optional retries and timeout. */
export interface TaskDefinition<TInput = unknown> {
  name: string;
  handler: (input: TInput, ctx: TaskContext) => Promise<void>;
  retries?: number;
  timeout?: number;
}

/** Context passed to a task handler: task ID, current attempt number, and a child logger. */
export interface TaskContext {
  taskId: string;
  attempt: number;
  log: Logger;
}

/** Registry mapping task names to their definitions. */
export class TaskRegistry {
  private tasks = new Map<string, TaskDefinition>();

  register<TInput>(definition: TaskDefinition<TInput>): void {
    this.tasks.set(definition.name, definition as TaskDefinition);
  }

  get(name: string): TaskDefinition | undefined {
    return this.tasks.get(name);
  }

  has(name: string): boolean {
    return this.tasks.has(name);
  }
}

/** Configuration for the task worker: concurrency and poll interval. */
export interface TaskWorkerOptions {
  concurrency?: number;
  pollInterval?: number;
}

/**
 * Background worker that polls the queue and executes tasks with retry logic.
 * Supports configurable concurrency and exponential backoff on failure.
 */
export class TaskWorker {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeJobs = 0;
  private readonly concurrency: number;
  private readonly pollInterval: number;

  constructor(
    private registry: TaskRegistry,
    private queue: QueueBackend,
    private log: Logger,
    options: TaskWorkerOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 1;
    this.pollInterval = options.pollInterval ?? 1000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for active jobs to finish
    while (this.activeJobs > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private poll(): void {
    if (!this.running) return;

    const tick = async () => {
      if (!this.running) return;

      while (this.activeJobs < this.concurrency && this.running) {
        const message = await this.queue.pop();
        if (!message) break;
        this.activeJobs++;
        this.processMessage(message).finally(() => {
          this.activeJobs--;
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
    const definition = this.registry.get(message.taskName);
    if (!definition) {
      this.log.error("Unknown task", { taskName: message.taskName });
      await this.queue.ack(message.id);
      return;
    }

    const ctx: TaskContext = {
      taskId: message.id,
      attempt: message.attempt,
      log: this.log.child({ taskId: message.id, taskName: message.taskName }),
    };

    try {
      if (definition.timeout) {
        await Promise.race([
          definition.handler(message.input, ctx),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new CelsianError(`Task "${message.taskName}" timed out after ${definition.timeout}ms`)),
              definition.timeout,
            ),
          ),
        ]);
      } else {
        await definition.handler(message.input, ctx);
      }
      await this.queue.ack(message.id);
    } catch (error) {
      const retries = definition.retries ?? 0;
      if (message.attempt < retries) {
        const delay = Math.min(1000 * 2 ** message.attempt, 30000);
        await this.queue.nack(message.id, delay);
        ctx.log.warn("Task failed, retrying", {
          attempt: message.attempt,
          maxRetries: retries,
          error: (error as Error).message,
        });
      } else {
        await this.queue.ack(message.id);
        ctx.log.error("Task failed permanently", {
          attempt: message.attempt,
          error: (error as Error).message,
        });
      }
    }
  }
}

/** Create an enqueue function bound to a queue backend and task registry. */
export function createEnqueue(queue: QueueBackend, registry: TaskRegistry) {
  return async function enqueue(taskName: string, input: unknown): Promise<string> {
    if (!registry.has(taskName)) {
      throw new CelsianError(`Unknown task: "${taskName}". Register it with taskRegistry.register() before enqueuing.`);
    }
    const definition = registry.get(taskName);
    if (!definition) {
      throw new CelsianError(`Unknown task: "${taskName}". Register it with taskRegistry.register() before enqueuing.`);
    }

    const id = generateQueueId();
    const message: QueueMessage = {
      id,
      taskName,
      input,
      attempt: 0,
      maxRetries: definition.retries ?? 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    };
    await queue.push(message);
    return id;
  };
}
