// @celsian/server — Task queue and cron scheduler tests

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTaskQueue, createCronScheduler } from '../src/tasks.js';

describe('TaskQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers and processes a task', async () => {
    const queue = createTaskQueue({ pollIntervalMs: 10 });
    const results: string[] = [];

    queue.register({
      name: 'greet',
      handler: async (job) => {
        results.push(`Hello ${job.payload.name}`);
        return { success: true };
      },
    });

    queue.start();
    await queue.enqueue('greet', { name: 'Alice' });

    // Wait for processing
    await new Promise(r => setTimeout(r, 50));
    await queue.stop();

    expect(results).toEqual(['Hello Alice']);
  });

  it('processes multiple jobs', async () => {
    const queue = createTaskQueue({ pollIntervalMs: 10 });
    const results: number[] = [];

    queue.register({
      name: 'add',
      handler: async (job) => {
        results.push(job.payload.n as number);
        return { success: true };
      },
    });

    queue.start();
    await queue.enqueue('add', { n: 1 });
    await queue.enqueue('add', { n: 2 });
    await queue.enqueue('add', { n: 3 });

    await new Promise(r => setTimeout(r, 100));
    await queue.stop();

    expect(results.sort()).toEqual([1, 2, 3]);
  });

  it('retries failed jobs', async () => {
    const queue = createTaskQueue({ pollIntervalMs: 10 });
    let attempts = 0;

    queue.register({
      name: 'flaky',
      handler: async () => {
        attempts++;
        if (attempts < 3) {
          return { success: false, error: 'not yet' };
        }
        return { success: true };
      },
      maxRetries: 3,
      retryDelayMs: 10,
    });

    queue.start();
    await queue.enqueue('flaky', {});

    await new Promise(r => setTimeout(r, 200));
    await queue.stop();

    expect(attempts).toBe(3);
    const stats = queue.stats();
    expect(stats.completed).toBe(1);
  });

  it('marks jobs as failed after max retries', async () => {
    const queue = createTaskQueue({ pollIntervalMs: 10 });

    queue.register({
      name: 'always-fail',
      handler: async () => ({ success: false, error: 'nope' }),
      maxRetries: 2,
      retryDelayMs: 10,
    });

    queue.start();
    await queue.enqueue('always-fail', {});

    await new Promise(r => setTimeout(r, 200));
    await queue.stop();

    const stats = queue.stats();
    expect(stats.failed).toBe(1);
    expect(stats.completed).toBe(0);
  });

  it('respects concurrency', async () => {
    const queue = createTaskQueue({ concurrency: 2, pollIntervalMs: 10 });
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    queue.register({
      name: 'slow',
      handler: async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(r => setTimeout(r, 30));
        currentConcurrent--;
        return { success: true };
      },
    });

    queue.start();
    for (let i = 0; i < 5; i++) {
      await queue.enqueue('slow', {});
    }

    await new Promise(r => setTimeout(r, 300));
    await queue.stop();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(queue.stats().completed).toBe(5);
  });

  it('throws when enqueueing unregistered task', async () => {
    const queue = createTaskQueue();
    await expect(queue.enqueue('unknown', {})).rejects.toThrow('No handler registered');
  });

  it('stats tracks job states', async () => {
    const queue = createTaskQueue({ pollIntervalMs: 10 });

    queue.register({
      name: 'counter',
      handler: async () => ({ success: true }),
    });

    const stats1 = queue.stats();
    expect(stats1.total).toBe(0);

    await queue.enqueue('counter', {});
    await queue.enqueue('counter', {});

    const stats2 = queue.stats();
    expect(stats2.pending).toBe(2);
    expect(stats2.total).toBe(2);

    queue.start();
    await new Promise(r => setTimeout(r, 100));
    await queue.stop();

    const stats3 = queue.stats();
    expect(stats3.completed).toBe(2);
  });

  it('getJob returns job details', async () => {
    const queue = createTaskQueue();
    queue.register({
      name: 'test',
      handler: async () => ({ success: true }),
    });

    const jobId = await queue.enqueue('test', { key: 'value' });
    const job = queue.getJob(jobId);

    expect(job).toBeDefined();
    expect(job!.name).toBe('test');
    expect(job!.payload).toEqual({ key: 'value' });
    expect(job!.id).toBe(jobId);
  });

  it('getJob returns undefined for unknown ID', () => {
    const queue = createTaskQueue();
    expect(queue.getJob('nonexistent')).toBeUndefined();
  });

  it('supports delayed jobs', async () => {
    const queue = createTaskQueue({ pollIntervalMs: 10 });
    const results: number[] = [];

    queue.register({
      name: 'delayed',
      handler: async () => {
        results.push(Date.now());
        return { success: true };
      },
    });

    queue.start();
    const before = Date.now();
    await queue.enqueue('delayed', {}, { delay: 50 });

    await new Promise(r => setTimeout(r, 150));
    await queue.stop();

    expect(results).toHaveLength(1);
    expect(results[0]! - before).toBeGreaterThanOrEqual(40); // Allow some timing slack
  });

  it('handles handler exceptions as failures', async () => {
    const queue = createTaskQueue({ pollIntervalMs: 10 });

    queue.register({
      name: 'throw',
      handler: async () => {
        throw new Error('boom');
      },
      maxRetries: 1,
      retryDelayMs: 10,
    });

    queue.start();
    await queue.enqueue('throw', {});

    await new Promise(r => setTimeout(r, 100));
    await queue.stop();

    expect(queue.stats().failed).toBe(1);
  });
});

describe('CronScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs jobs on interval', async () => {
    vi.useFakeTimers();
    const cron = createCronScheduler();
    const calls: number[] = [];

    cron.add({
      name: 'ticker',
      schedule: '1s',
      handler: () => { calls.push(Date.now()); },
    });

    cron.start();

    vi.advanceTimersByTime(3500);
    cron.stop();

    expect(calls.length).toBe(3);
  });

  it('runs immediately when configured', () => {
    const calls: string[] = [];
    const cron = createCronScheduler();

    cron.add({
      name: 'immediate',
      schedule: '1h',
      immediate: true,
      handler: () => { calls.push('ran'); },
    });

    cron.start();
    expect(calls).toEqual(['ran']);
    cron.stop();
  });

  it('parses schedule formats', () => {
    vi.useFakeTimers();
    const cron = createCronScheduler();
    const calls: string[] = [];

    cron.add({
      name: 'seconds',
      schedule: '500ms',
      handler: () => { calls.push('ms'); },
    });

    cron.start();
    vi.advanceTimersByTime(1600);
    cron.stop();

    expect(calls.length).toBe(3); // 500, 1000, 1500
  });

  it('supports "every" prefix', () => {
    vi.useFakeTimers();
    const cron = createCronScheduler();
    const calls: string[] = [];

    cron.add({
      name: 'every',
      schedule: 'every 2s',
      handler: () => { calls.push('tick'); },
    });

    cron.start();
    vi.advanceTimersByTime(5000);
    cron.stop();

    expect(calls.length).toBe(2); // 2s, 4s
  });

  it('supports numeric schedule (ms)', () => {
    vi.useFakeTimers();
    const cron = createCronScheduler();
    let count = 0;

    cron.add({
      name: 'numeric',
      schedule: 200,
      handler: () => { count++; },
    });

    cron.start();
    vi.advanceTimersByTime(500);
    cron.stop();

    expect(count).toBe(2);
  });

  it('stop prevents further executions', () => {
    vi.useFakeTimers();
    const cron = createCronScheduler();
    let count = 0;

    cron.add({
      name: 'counter',
      schedule: '100ms',
      handler: () => { count++; },
    });

    cron.start();
    vi.advanceTimersByTime(350);
    cron.stop();
    const countAtStop = count;

    vi.advanceTimersByTime(500);
    expect(count).toBe(countAtStop);
  });

  it('list returns registered jobs', () => {
    const cron = createCronScheduler();
    cron.add({ name: 'a', schedule: '1s', handler: () => {} });
    cron.add({ name: 'b', schedule: '5m', handler: () => {} });

    const list = cron.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.name).toBe('a');
    expect(list[1]!.name).toBe('b');
    expect(list[0]!.running).toBe(false);

    cron.start();
    const list2 = cron.list();
    expect(list2[0]!.running).toBe(true);
    cron.stop();
  });

  it('swallows errors in handlers', () => {
    vi.useFakeTimers();
    const cron = createCronScheduler();

    cron.add({
      name: 'faulty',
      schedule: '100ms',
      handler: () => { throw new Error('oops'); },
    });

    // Should not throw
    cron.start();
    vi.advanceTimersByTime(300);
    cron.stop();
  });
});
