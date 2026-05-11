// @celsian/queue-redis — Redis-backed queue for CelsianJS task system

import type { QueueBackend, QueueMessage } from "@celsian/core";
import Redis from "ioredis";

export interface RedisQueueOptions {
  /** Redis connection URL (redis://...) */
  url?: string;
  /** Existing ioredis client instance */
  client?: Redis;
  /** Key prefix for all queue keys (default: 'celsian:queue') */
  prefix?: string;
  /** Visibility timeout in ms — how long a popped message stays in-flight before auto-nack (default: 30000) */
  visibilityTimeout?: number;
}

export class RedisQueue implements QueueBackend {
  private redis: Redis;
  private ownsClient: boolean;
  private prefix: string;
  private visibilityTimeout: number;

  // Redis key names
  private pendingKey: string; // LIST — pending messages
  private inflightKey: string; // HASH — in-flight messages by id
  private delayedKey: string; // SORTED SET — delayed messages (score = availableAt)
  private inflightDeadlinesKey: string; // SORTED SET — in-flight message ids (score = visibility deadline)

  constructor(options: RedisQueueOptions = {}) {
    if (options.client) {
      this.redis = options.client;
      this.ownsClient = false;
    } else {
      this.redis = new Redis(options.url ?? "redis://localhost:6379", {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      this.ownsClient = true;
    }

    this.prefix = options.prefix ?? "celsian:queue";
    this.visibilityTimeout = options.visibilityTimeout ?? 30_000;
    this.pendingKey = `${this.prefix}:pending`;
    this.inflightKey = `${this.prefix}:inflight`;
    this.delayedKey = `${this.prefix}:delayed`;
    this.inflightDeadlinesKey = `${this.prefix}:inflight:deadlines`;
  }

  async connect(): Promise<void> {
    if (this.ownsClient && this.redis.status === "wait") {
      await this.redis.connect();
    }
  }

  async push(message: QueueMessage): Promise<void> {
    await this.connect();
    const serialized = JSON.stringify(message);

    if (message.availableAt > Date.now()) {
      // Delayed message — add to sorted set
      await this.redis.zadd(this.delayedKey, message.availableAt, serialized);
    } else {
      // Immediately available — push to list
      await this.redis.lpush(this.pendingKey, serialized);
    }
  }

  async pop(): Promise<QueueMessage | null> {
    await this.connect();

    // First, make expired in-flight messages visible again, then move delayed messages that are now available
    await this.promoteExpiredInflight();
    await this.promoteDelayed();

    // Pop from pending list (non-blocking)
    const raw = await this.redis.rpop(this.pendingKey);
    if (!raw) return null;

    const message: QueueMessage = JSON.parse(raw);

    // Track in-flight and its visibility deadline. If the worker crashes before ack/nack,
    // a future pop() will re-queue the message once this deadline passes.
    const visibilityDeadline = Date.now() + this.visibilityTimeout;
    await this.redis
      .pipeline()
      .hset(this.inflightKey, message.id, raw)
      .zadd(this.inflightDeadlinesKey, visibilityDeadline, message.id)
      .exec();

    return message;
  }

  async ack(id: string): Promise<void> {
    await this.connect();
    await this.redis.pipeline().hdel(this.inflightKey, id).zrem(this.inflightDeadlinesKey, id).exec();
  }

  async nack(id: string, delay = 1000): Promise<void> {
    await this.connect();
    const raw = await this.redis.hget(this.inflightKey, id);
    if (!raw) return;

    const message: QueueMessage = JSON.parse(raw);
    message.attempt++;
    message.availableAt = Date.now() + delay;

    // Remove from in-flight
    await this.redis.pipeline().hdel(this.inflightKey, id).zrem(this.inflightDeadlinesKey, id).exec();

    // Re-queue with delay
    const serialized = JSON.stringify(message);
    if (delay > 0) {
      await this.redis.zadd(this.delayedKey, message.availableAt, serialized);
    } else {
      await this.redis.lpush(this.pendingKey, serialized);
    }
  }

  async size(): Promise<number> {
    await this.connect();
    await this.promoteExpiredInflight();
    const [pendingLen, delayedLen] = await Promise.all([
      this.redis.llen(this.pendingKey),
      this.redis.zcard(this.delayedKey),
    ]);
    return pendingLen + delayedLen;
  }

  /** Move expired in-flight messages back to the pending list */
  private async promoteExpiredInflight(): Promise<void> {
    const now = Date.now();
    const expiredIds = await this.redis.zrangebyscore(this.inflightDeadlinesKey, 0, now);
    if (expiredIds.length === 0) return;

    for (const id of expiredIds) {
      await this.redis.eval(
        `
        local raw = redis.call("HGET", KEYS[1], ARGV[1])
        redis.call("ZREM", KEYS[2], ARGV[1])
        if not raw then
          return 0
        end
        redis.call("HDEL", KEYS[1], ARGV[1])
        redis.call("LPUSH", KEYS[3], raw)
        return 1
        `,
        3,
        this.inflightKey,
        this.inflightDeadlinesKey,
        this.pendingKey,
        id,
      );
    }
  }

  /** Move delayed messages whose availableAt has passed to the pending list */
  private async promoteDelayed(): Promise<void> {
    const now = Date.now();
    // Get delayed messages that are now available
    const ready = await this.redis.zrangebyscore(this.delayedKey, 0, now);
    if (ready.length === 0) return;

    // Use a pipeline for atomicity
    const pipeline = this.redis.pipeline();
    for (const raw of ready) {
      pipeline.lpush(this.pendingKey, raw);
    }
    pipeline.zremrangebyscore(this.delayedKey, 0, now);
    await pipeline.exec();
  }

  /** Close the Redis connection (only if we own it) */
  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.redis.quit();
    }
  }

  /** Flush all queue data (for testing) */
  async flush(): Promise<void> {
    await this.connect();
    await this.redis.del(this.pendingKey, this.inflightKey, this.inflightDeadlinesKey, this.delayedKey);
  }
}
