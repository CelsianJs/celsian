import { describe, it, expect } from 'vitest';
import { MemoryQueue, generateQueueId } from '../src/queue.js';

describe('MemoryQueue', () => {
  it('should push and pop messages', async () => {
    const queue = new MemoryQueue();

    await queue.push({
      id: 'msg-1',
      taskName: 'test',
      input: { data: 1 },
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const msg = await queue.pop();
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe('msg-1');
    expect(msg!.input).toEqual({ data: 1 });
  });

  it('should return null when empty', async () => {
    const queue = new MemoryQueue();
    const msg = await queue.pop();
    expect(msg).toBeNull();
  });

  it('should ack messages', async () => {
    const queue = new MemoryQueue();

    await queue.push({
      id: 'msg-1',
      taskName: 'test',
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const msg = await queue.pop();
    await queue.ack(msg!.id);

    expect(await queue.size()).toBe(0);
  });

  it('should nack messages (re-queue with delay)', async () => {
    const queue = new MemoryQueue();

    await queue.push({
      id: 'msg-1',
      taskName: 'test',
      input: {},
      attempt: 0,
      maxRetries: 1,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const msg = await queue.pop();
    await queue.nack(msg!.id, 0);

    expect(await queue.size()).toBe(1);

    const requeued = await queue.pop();
    expect(requeued!.attempt).toBe(1);
  });

  it('should respect availableAt for delayed messages', async () => {
    const queue = new MemoryQueue();

    await queue.push({
      id: 'msg-1',
      taskName: 'test',
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now() + 10000,
    });

    // Should not be available yet
    const msg = await queue.pop();
    expect(msg).toBeNull();

    expect(await queue.size()).toBe(1);
  });

  it('should report size', async () => {
    const queue = new MemoryQueue();

    expect(await queue.size()).toBe(0);

    await queue.push({
      id: 'a',
      taskName: 'test',
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });
    await queue.push({
      id: 'b',
      taskName: 'test',
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    expect(await queue.size()).toBe(2);
  });
});

describe('generateQueueId', () => {
  it('should generate unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateQueueId());
    }
    expect(ids.size).toBe(100);
  });
});
