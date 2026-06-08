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
  /**
   * Optional callback for connection-level errors emitted by an owned ioredis
   * client. Defaults to logging via console.error. Ignored when an external
   * `client` is supplied (the caller owns its own error handling).
   */
  onError?: (error: Error) => void;
}

/**
 * Atomically pop the oldest pending message, push it onto the processing list,
 * and record its in-flight start timestamp.
 *
 * KEYS[1] = pending list, KEYS[2] = processing list, KEYS[3] = stamps hash
 * ARGV[1] = now (ms)
 *
 * Returns the raw message string, or false when the pending list is empty. The
 * pop + stamp happen in a single round-trip so a crash can never leave a message
 * popped-but-untracked (the bug with rpop + a separate hset).
 */
const POP_SCRIPT = `
local raw = redis.call('RPOPLPUSH', KEYS[1], KEYS[2])
if not raw then
  return false
end
redis.call('HSET', KEYS[3], raw, ARGV[1])
return raw
`;

/**
 * Reclaim in-flight messages whose age exceeds the visibility timeout: remove
 * them from the processing list + stamps hash and re-queue onto pending.
 *
 * KEYS[1] = processing list, KEYS[2] = stamps hash, KEYS[3] = pending list
 * ARGV[1] = cutoff timestamp (now - visibilityTimeout)
 *
 * Returns the number of messages reclaimed.
 */
const REAP_SCRIPT = `
local entries = redis.call('LRANGE', KEYS[1], 0, -1)
local reclaimed = 0
for i = 1, #entries do
  local raw = entries[i]
  local stamp = redis.call('HGET', KEYS[2], raw)
  if stamp == false or tonumber(stamp) <= tonumber(ARGV[1]) then
    redis.call('LREM', KEYS[1], 1, raw)
    redis.call('HDEL', KEYS[2], raw)
    redis.call('LPUSH', KEYS[3], raw)
    reclaimed = reclaimed + 1
  end
end
return reclaimed
`;

export class RedisQueue implements QueueBackend {
  private redis: Redis;
  private ownsClient: boolean;
  private prefix: string;
  private visibilityTimeout: number;

  // Redis key names
  private pendingKey: string; // LIST — pending messages
  private processingKey: string; // LIST — in-flight messages (atomically moved here on pop)
  private stampsKey: string; // HASH — raw message -> in-flight start timestamp (ms)
  private delayedKey: string; // SORTED SET — delayed messages (score = availableAt)

  constructor(options: RedisQueueOptions = {}) {
    const onError =
      options.onError ??
      ((error: Error) => {
        console.error("[celsian:queue-redis] redis client error:", error.message);
      });

    if (options.client) {
      this.redis = options.client;
      this.ownsClient = false;
      // We don't own external clients, so we don't attach our own error handler —
      // the caller is responsible for handling 'error' on a client they created.
    } else {
      this.redis = new Redis(options.url ?? "redis://localhost:6379", {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      this.ownsClient = true;
      // Attach an 'error' listener so a connection failure degrades (logs)
      // instead of emitting an unhandled 'error' event that crashes the process.
      this.redis.on("error", onError);
    }

    this.prefix = options.prefix ?? "celsian:queue";
    this.visibilityTimeout = options.visibilityTimeout ?? 30_000;
    this.pendingKey = `${this.prefix}:pending`;
    this.processingKey = `${this.prefix}:processing`;
    this.stampsKey = `${this.prefix}:stamps`;
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

    // Reclaim any in-flight messages whose visibility timeout has elapsed so
    // they become poppable again before we look for new work.
    await this.reap();

    // Atomically move the oldest pending message into the processing list and
    // stamp its in-flight start time. Single round-trip — no popped-but-untracked
    // window.
    const raw = (await this.redis.eval(
      POP_SCRIPT,
      3,
      this.pendingKey,
      this.processingKey,
      this.stampsKey,
      Date.now().toString(),
    )) as string | null;

    if (!raw) return null;

    const message: QueueMessage = JSON.parse(raw);
    return message;
  }

  async ack(id: string): Promise<void> {
    await this.connect();
    // The raw payload is the value stored in both the processing list and stamps
    // hash, so we look it up by id, then remove it from both atomically.
    const raw = await this.findProcessingRaw(id);
    if (!raw) return;
    await this.removeFromProcessing(raw);
  }

  async nack(id: string, delay = 1000): Promise<void> {
    await this.connect();
    const raw = await this.findProcessingRaw(id);
    if (!raw) return;

    const message: QueueMessage = JSON.parse(raw);
    message.attempt++;
    message.availableAt = Date.now() + delay;

    // Remove the original payload from the processing structures.
    await this.removeFromProcessing(raw);

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

  /**
   * Re-queue in-flight messages whose age exceeds visibilityTimeout. Public so
   * a worker can drive reclamation explicitly; also invoked on every pop().
   * Returns the number of messages reclaimed.
   */
  async reap(): Promise<number> {
    const cutoff = Date.now() - this.visibilityTimeout;
    const reclaimed = (await this.redis.eval(
      REAP_SCRIPT,
      3,
      this.processingKey,
      this.stampsKey,
      this.pendingKey,
      cutoff.toString(),
    )) as number;
    return reclaimed;
  }

  /** Find the raw processing payload for a message id (scans the processing list). */
  private async findProcessingRaw(id: string): Promise<string | null> {
    const entries = await this.redis.lrange(this.processingKey, 0, -1);
    for (const raw of entries) {
      try {
        const parsed: QueueMessage = JSON.parse(raw);
        if (parsed.id === id) return raw;
      } catch {
        // Skip unparseable entries
      }
    }
    return null;
  }

  /** Remove a raw payload from both the processing list and the stamps hash. */
  private async removeFromProcessing(raw: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.lrem(this.processingKey, 1, raw);
    pipeline.hdel(this.stampsKey, raw);
    await pipeline.exec();
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
    await this.redis.del(this.pendingKey, this.processingKey, this.stampsKey, this.delayedKey);
  }
}
