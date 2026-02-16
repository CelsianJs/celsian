import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { TaskRegistry, TaskWorker } from '../src/task.js';
import { MemoryQueue } from '../src/queue.js';
import { createLogger } from '../src/logger.js';

describe('Task System', () => {
  it('should register and enqueue tasks', async () => {
    const app = createApp();
    const results: string[] = [];

    app.task({
      name: 'test-task',
      handler: async (input: { msg: string }) => {
        results.push(input.msg);
      },
    });

    const id = await app.enqueue('test-task', { msg: 'hello' });
    expect(typeof id).toBe('string');
  });

  it('should throw on unknown task enqueue', async () => {
    const app = createApp();
    await expect(app.enqueue('nonexistent', {})).rejects.toThrow('Unknown task: nonexistent');
  });

  it('should process tasks via worker', async () => {
    const results: unknown[] = [];
    const logger = createLogger({ destination: () => {} });
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();

    registry.register({
      name: 'process-me',
      handler: async (input) => {
        results.push(input);
      },
    });

    // Push a message directly
    await queue.push({
      id: 'test-1',
      taskName: 'process-me',
      input: { data: 42 },
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();

    // Wait for processing
    await new Promise(r => setTimeout(r, 200));
    await worker.stop();

    expect(results).toEqual([{ data: 42 }]);
  });

  it('should retry failed tasks', async () => {
    let attempts = 0;
    const logger = createLogger({ destination: () => {} });
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();

    registry.register({
      name: 'retry-me',
      retries: 2,
      handler: async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('fail');
        }
      },
    });

    await queue.push({
      id: 'retry-1',
      taskName: 'retry-me',
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
    await new Promise(r => setTimeout(r, 4000));
    await worker.stop();

    expect(attempts).toBe(3);
  });

  it('should respect task timeout', async () => {
    const logger = createLogger({ destination: () => {} });
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();
    let completed = false;

    registry.register({
      name: 'slow-task',
      timeout: 50,
      handler: async () => {
        await new Promise(r => setTimeout(r, 5000));
        completed = true;
      },
    });

    await queue.push({
      id: 'timeout-1',
      taskName: 'slow-task',
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();

    await new Promise(r => setTimeout(r, 300));
    await worker.stop();

    expect(completed).toBe(false);
  });

  it('should integrate with app', async () => {
    const app = createApp();
    const processed: string[] = [];

    app.task({
      name: 'email',
      handler: async (input: { to: string }) => {
        processed.push(input.to);
      },
    });

    await app.enqueue('email', { to: 'user@example.com' });

    app.startWorker();
    await new Promise(r => setTimeout(r, 200));
    await app.stopWorker();

    expect(processed).toContain('user@example.com');
  });
});
