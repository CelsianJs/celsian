import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { RedisQueue } from '../src/index.js';

const REDIS_URL = process.env.REDIS_URL;

// Skip all tests if no Redis URL configured
const describeWithRedis = REDIS_URL ? describe : describe.skip;

describeWithRedis('RedisQueue', () => {
  let queue: RedisQueue;

  beforeEach(async () => {
    queue = new RedisQueue({
      url: REDIS_URL,
      prefix: 'celsian:test:queue',
    });
    await queue.flush();
  });

  afterAll(async () => {
    if (queue) {
      await queue.flush();
      await queue.close();
    }
  });

  it('should push and pop a message', async () => {
    await queue.push({
      id: 'msg-1',
      taskName: 'test-task',
      input: { foo: 'bar' },
      attempt: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      availableAt: 0,
    });

    const msg = await queue.pop();
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe('msg-1');
    expect(msg!.taskName).toBe('test-task');
    expect(msg!.input).toEqual({ foo: 'bar' });
  });

  it('should return null when queue is empty', async () => {
    const msg = await queue.pop();
    expect(msg).toBeNull();
  });

  it('should ack a message (remove from in-flight)', async () => {
    await queue.push({
      id: 'msg-2',
      taskName: 'test-task',
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: 0,
    });

    const msg = await queue.pop();
    expect(msg).not.toBeNull();
    await queue.ack(msg!.id);

    // Should not be able to pop again
    const msg2 = await queue.pop();
    expect(msg2).toBeNull();
  });

  it('should nack and re-queue a message', async () => {
    await queue.push({
      id: 'msg-3',
      taskName: 'test-task',
      input: {},
      attempt: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      availableAt: 0,
    });

    const msg = await queue.pop();
    expect(msg!.attempt).toBe(0);

    // Nack with no delay so it's immediately available
    await queue.nack(msg!.id, 0);

    const msg2 = await queue.pop();
    expect(msg2).not.toBeNull();
    expect(msg2!.id).toBe('msg-3');
    expect(msg2!.attempt).toBe(1);
  });

  it('should report size', async () => {
    expect(await queue.size()).toBe(0);

    await queue.push({
      id: 'msg-4',
      taskName: 'test-task',
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: 0,
    });

    expect(await queue.size()).toBe(1);

    await queue.push({
      id: 'msg-5',
      taskName: 'test-task',
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: 0,
    });

    expect(await queue.size()).toBe(2);
  });

  it('should handle delayed messages', async () => {
    await queue.push({
      id: 'msg-delayed',
      taskName: 'test-task',
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now() + 100, // Available in 100ms
    });

    // Should not be available yet
    const msg1 = await queue.pop();
    expect(msg1).toBeNull();

    // Wait for it to become available
    await new Promise(r => setTimeout(r, 150));

    const msg2 = await queue.pop();
    expect(msg2).not.toBeNull();
    expect(msg2!.id).toBe('msg-delayed');
  });

  it('should count delayed messages in size', async () => {
    await queue.push({
      id: 'msg-d1',
      taskName: 'test-task',
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now() + 60_000,
    });

    expect(await queue.size()).toBe(1);
  });
});

// Basic unit tests that don't require Redis
describe('RedisQueue (unit)', () => {
  it('should accept URL option', () => {
    const queue = new RedisQueue({ url: 'redis://localhost:6379' });
    expect(queue).toBeDefined();
    // Don't actually connect
  });

  it('should accept custom prefix', () => {
    const queue = new RedisQueue({ prefix: 'my-app:queue' });
    expect(queue).toBeDefined();
  });
});
