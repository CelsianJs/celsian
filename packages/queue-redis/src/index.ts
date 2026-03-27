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

    // First, move any delayed messages that are now available
    await this.promoteDelayed();

    // Pop from pending list (non-blocking)
    const raw = await this.redis.rpop(this.pendingKey);
    if (!raw) return null;

    const message: QueueMessage = JSON.parse(raw);

    // Track in-flight with expiry
    await this.redis.hset(this.inflightKey, message.id, raw);

    return message;
  }

  async ack(id: string): Promise<void> {
    await this.connect();
    await this.redis.hdel(this.inflightKey, id);
  }

  async nack(id: string, delay = 1000): Promise<void> {
    await this.connect();
    const raw = await this.redis.hget(this.inflightKey, id);
    if (!raw) return;

    const message: QueueMessage = JSON.parse(raw);
    message.attempt++;
    message.availableAt = Date.now() + delay;

    // Remove from in-flight
    await this.redis.hdel(this.inflightKey, id);

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
    const [pendingLen, delayedLen] = await Promise.all([
      this.redis.llen(this.pendingKey),
      this.redis.zcard(this.delayedKey),
    ]);
    return pendingLen + delayedLen;
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
    await this.redis.del(this.pendingKey, this.inflightKey, this.delayedKey);
  }
}
