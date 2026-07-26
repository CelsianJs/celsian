// @celsian/queue-redis — Redis-backed queue for CelsianJS task system

import type { QueueBackend, QueueMessage } from "@celsian/core";
import Redis from "ioredis";

/**
 * Structural mirrors of the dead-letter types in `@celsian/core`'s queue module.
 * They are re-declared here only because core's package exports do not yet
 * surface them; they are structurally identical, so `RedisQueue` still
 * type-checks against `QueueBackend`.
 */
export interface TaskFailure {
  attempt: number;
  error: string;
  failedAt: number;
}

export interface DeadLetterEntry {
  message: QueueMessage;
  error: string;
  failures: TaskFailure[];
  deadLetteredAt: number;
}

export interface RedisQueueOptions {
  /** Redis connection URL (redis://...) */
  url?: string;
  /** Existing ioredis client instance */
  client?: Redis;
  /** Key prefix for all queue keys (default: 'celsian:queue') */
  prefix?: string;
  /** Visibility timeout in ms — how long a popped message stays in-flight before auto-nack (default: 30000) */
  visibilityTimeout?: number;
  /** Maximum dead-letter entries retained; oldest are trimmed away (default: 10000) */
  maxDeadLetters?: number;
  /**
   * Optional callback for connection-level errors emitted by an owned ioredis
   * client. Defaults to logging via console.error. Ignored when an external
   * `client` is supplied (the caller owns its own error handling).
   */
  onError?: (error: Error) => void;
}

/**
 * Separator between a delivery's lease token and the message payload inside the
 * processing list. Every delivery gets a fresh token, so an in-flight entry is
 * `<token>|<raw json>` and can only be removed by the delivery that owns it.
 * A UUID never contains this character, so the split is unambiguous.
 */
const LEASE_SEP = "|";

/**
 * Atomically pop the oldest pending message, push it onto the processing list
 * under a fresh lease token, and record when that lease expires.
 *
 * KEYS[1] = pending list, KEYS[2] = processing list, KEYS[3] = leases hash
 * ARGV[1] = lease expiry (epoch ms), ARGV[2] = lease token
 *
 * Returns the in-flight entry (`token|raw`), or false when nothing is pending.
 * The pop, the lease and the expiry are one round-trip, so a crash can never
 * leave a message popped-but-untracked.
 */
const POP_SCRIPT = `
local raw = redis.call('RPOP', KEYS[1])
if not raw then
  return false
end
local entry = ARGV[2] .. '${LEASE_SEP}' .. raw
redis.call('LPUSH', KEYS[2], entry)
redis.call('HSET', KEYS[3], entry, ARGV[1])
return entry
`;

/**
 * Remove the in-flight entry owned by a specific lease token.
 *
 * KEYS[1] = processing list, KEYS[2] = leases hash
 * ARGV[1] = lease prefix (`token|`)
 *
 * Returns the removed entry, or false when this lease no longer owns anything —
 * which is exactly what stops a worker whose lease already expired from acking
 * away the delivery that another worker now owns.
 */
const RELEASE_BY_LEASE_SCRIPT = `
local entries = redis.call('LRANGE', KEYS[1], 0, -1)
local prefix = ARGV[1]
for i = 1, #entries do
  local entry = entries[i]
  if string.sub(entry, 1, #prefix) == prefix then
    redis.call('LREM', KEYS[1], 1, entry)
    redis.call('HDEL', KEYS[2], entry)
    return entry
  end
end
return false
`;

/**
 * Remove one exact in-flight entry (used for the legacy token-less ack path).
 *
 * KEYS[1] = processing list, KEYS[2] = leases hash ; ARGV[1] = exact entry
 * Returns 1 when this call is the one that removed it, else 0.
 */
const RELEASE_EXACT_SCRIPT = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 0 then
  return 0
end
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`;

/**
 * Push a lease's expiry out (heartbeat), only while that lease still owns an entry.
 *
 * KEYS[1] = processing list, KEYS[2] = leases hash
 * ARGV[1] = lease prefix (`token|`), ARGV[2] = new expiry (epoch ms)
 * Returns 1 when the lease was extended, 0 when it is already lost.
 */
const EXTEND_SCRIPT = `
local entries = redis.call('LRANGE', KEYS[1], 0, -1)
local prefix = ARGV[1]
for i = 1, #entries do
  local entry = entries[i]
  if string.sub(entry, 1, #prefix) == prefix then
    redis.call('HSET', KEYS[2], entry, ARGV[2])
    return 1
  end
end
return 0
`;

/**
 * Move every in-flight entry whose lease has expired onto a reclaim staging
 * list, atomically.
 *
 * KEYS[1] = processing list, KEYS[2] = leases hash, KEYS[3] = reclaim list
 * ARGV[1] = now (epoch ms)
 *
 * Staging exists because deciding what happens next (retry vs dead-letter)
 * requires rewriting the message's attempt counter, and that rewrite must
 * happen in JavaScript: Redis' cjson cannot round-trip arbitrary user payloads
 * (an empty array re-encodes as an empty object). A crash mid-reclaim therefore
 * leaves entries parked in staging, and the next reap drains them — no loss.
 */
const REAP_SCRIPT = `
local entries = redis.call('LRANGE', KEYS[1], 0, -1)
local now = tonumber(ARGV[1])
local staged = 0
for i = 1, #entries do
  local entry = entries[i]
  local expiry = redis.call('HGET', KEYS[2], entry)
  if expiry == false or tonumber(expiry) <= now then
    if redis.call('LREM', KEYS[1], 1, entry) > 0 then
      redis.call('HDEL', KEYS[2], entry)
      redis.call('LPUSH', KEYS[3], entry)
      staged = staged + 1
    end
  end
end
return staged
`;

/**
 * Take one staged entry and route it onward, atomically.
 *
 * KEYS[1] = reclaim list, KEYS[2] = destination list
 * ARGV[1] = staged entry, ARGV[2] = payload to push to the destination
 *
 * The LREM guard makes this idempotent: only the caller that actually removed
 * the staged entry pushes the result, so two concurrent reapers can never
 * duplicate a reclaimed message.
 */
const DRAIN_RECLAIM_SCRIPT = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 0 then
  return 0
end
redis.call('LPUSH', KEYS[2], ARGV[2])
return 1
`;

/**
 * Promote every delayed message whose time has come, atomically and exactly once.
 *
 * KEYS[1] = delayed sorted set, KEYS[2] = pending list
 * ARGV[1] = now (epoch ms), ARGV[2] = batch limit
 *
 * A whole Lua script is one atomic Redis operation, unlike `pipeline()`, which
 * only batches. Promotion is gated on ZREM returning 1, so if two workers run
 * this concurrently exactly one of them moves each message. Removal is by
 * member rather than by score range, so a message pushed into the score window
 * while the script runs cannot be deleted without being promoted.
 */
const PROMOTE_SCRIPT = `
local ready = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local moved = 0
for i = 1, #ready do
  if redis.call('ZREM', KEYS[1], ready[i]) == 1 then
    redis.call('LPUSH', KEYS[2], ready[i])
    moved = moved + 1
  end
end
return moved
`;

/**
 * Release a lease and dead-letter the job in one atomic step.
 *
 * KEYS[1] = processing list, KEYS[2] = leases hash, KEYS[3] = dead list
 * ARGV[1] = lease prefix (`token|`) or empty string, ARGV[2] = dead-letter entry JSON,
 * ARGV[3] = max dead-letter entries to retain
 */
const DEAD_LETTER_SCRIPT = `
local prefix = ARGV[1]
if #prefix > 0 then
  local entries = redis.call('LRANGE', KEYS[1], 0, -1)
  for i = 1, #entries do
    local entry = entries[i]
    if string.sub(entry, 1, #prefix) == prefix then
      redis.call('LREM', KEYS[1], 1, entry)
      redis.call('HDEL', KEYS[2], entry)
      break
    end
  end
end
redis.call('LPUSH', KEYS[3], ARGV[2])
redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[3]) - 1)
return 1
`;

/** Batch size for a single delayed-message promotion pass. */
const PROMOTE_BATCH = 500;

/**
 * Redis-backed, at-least-once queue.
 *
 * Durability: messages live in Redis, so they survive a worker process dying,
 * and multiple processes share one queue. Each delivery gets a distinct lease
 * token; an ack, nack or heartbeat only affects the delivery that owns the
 * lease. In-flight messages whose lease expires without an ack or heartbeat are
 * redelivered, and are dead-lettered rather than looped forever once their
 * retry budget is spent.
 */
export class RedisQueue implements QueueBackend {
  private redis: Redis;
  private ownsClient: boolean;
  private prefix: string;
  private maxDeadLetters: number;
  readonly visibilityTimeoutMs: number;

  // Redis key names
  private pendingKey: string; // LIST — pending messages
  private processingKey: string; // LIST — in-flight entries, `<leaseToken>|<raw>`
  private leasesKey: string; // HASH — in-flight entry -> lease expiry (ms)
  private delayedKey: string; // SORTED SET — delayed messages (score = availableAt)
  private reclaimKey: string; // LIST — staging area for expired leases
  private deadKey: string; // LIST — dead-letter entries (newest first)

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
    this.visibilityTimeoutMs = options.visibilityTimeout ?? 30_000;
    this.maxDeadLetters = options.maxDeadLetters ?? 10_000;
    this.pendingKey = `${this.prefix}:pending`;
    this.processingKey = `${this.prefix}:processing`;
    this.leasesKey = `${this.prefix}:leases`;
    this.delayedKey = `${this.prefix}:delayed`;
    this.reclaimKey = `${this.prefix}:reclaim`;
    this.deadKey = `${this.prefix}:dead`;
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

    // Reclaim any in-flight messages whose lease has elapsed so they become
    // poppable again before we look for new work.
    await this.reap();

    const leaseToken = crypto.randomUUID();
    const entry = (await this.redis.eval(
      POP_SCRIPT,
      3,
      this.pendingKey,
      this.processingKey,
      this.leasesKey,
      (Date.now() + this.visibilityTimeoutMs).toString(),
      leaseToken,
    )) as string | null;

    if (!entry) return null;

    const message: QueueMessage = JSON.parse(splitEntry(entry).raw);
    message.deliveries = (message.deliveries ?? 0) + 1;
    message.leaseToken = leaseToken;
    return message;
  }

  async ack(id: string, leaseToken?: string): Promise<void> {
    await this.connect();
    if (leaseToken) {
      await this.releaseLease(leaseToken);
      return;
    }
    // Legacy path: no lease token supplied, fall back to matching by id.
    const entry = await this.findProcessingEntry(id);
    if (!entry) return;
    await this.redis.eval(RELEASE_EXACT_SCRIPT, 2, this.processingKey, this.leasesKey, entry);
  }

  async nack(id: string, delay = 1000, leaseToken?: string, failure?: TaskFailure): Promise<void> {
    await this.connect();

    const entry = leaseToken ? await this.releaseLease(leaseToken) : await this.releaseById(id);
    if (!entry) return;

    const message: QueueMessage = JSON.parse(splitEntry(entry).raw);
    message.attempt++;
    // Persist the delivery count that pop() only held in memory, so the next
    // delivery sees an accurate total.
    message.deliveries = (message.deliveries ?? 0) + 1;
    message.availableAt = Date.now() + delay;
    message.leaseToken = undefined;
    if (failure) message.failures = [...(message.failures ?? []), failure];

    const serialized = JSON.stringify(message);
    if (delay > 0) {
      await this.redis.zadd(this.delayedKey, message.availableAt, serialized);
    } else {
      await this.redis.lpush(this.pendingKey, serialized);
    }
  }

  /**
   * Push this delivery's lease expiry out. Returns false when the lease is
   * already gone, meaning another worker may now own the message.
   */
  async extend(id: string, leaseToken: string, extraMs?: number): Promise<boolean> {
    await this.connect();
    const expiry = Date.now() + (extraMs ?? this.visibilityTimeoutMs);
    const extended = (await this.redis.eval(
      EXTEND_SCRIPT,
      2,
      this.processingKey,
      this.leasesKey,
      `${leaseToken}${LEASE_SEP}`,
      expiry.toString(),
    )) as number;
    return extended === 1;
  }

  async deadLetter(entry: DeadLetterEntry, leaseToken?: string): Promise<void> {
    await this.connect();
    await this.redis.eval(
      DEAD_LETTER_SCRIPT,
      3,
      this.processingKey,
      this.leasesKey,
      this.deadKey,
      leaseToken ? `${leaseToken}${LEASE_SEP}` : "",
      JSON.stringify(entry),
      this.maxDeadLetters.toString(),
    );
  }

  async listDeadLetters(limit = 100): Promise<DeadLetterEntry[]> {
    await this.connect();
    const raws = await this.redis.lrange(this.deadKey, 0, limit - 1);
    const entries: DeadLetterEntry[] = [];
    for (const raw of raws) {
      try {
        entries.push(JSON.parse(raw));
      } catch {
        // Skip unparseable entries rather than failing the whole listing.
      }
    }
    return entries;
  }

  async deadLetterSize(): Promise<number> {
    await this.connect();
    return this.redis.llen(this.deadKey);
  }

  async redriveDeadLetter(id: string): Promise<boolean> {
    await this.connect();
    const raws = await this.redis.lrange(this.deadKey, 0, -1);
    for (const raw of raws) {
      let entry: DeadLetterEntry;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (entry.message?.id !== id) continue;
      // Only the caller that actually removes the entry re-queues it, so
      // concurrent re-drives cannot duplicate the job.
      const removed = await this.redis.lrem(this.deadKey, 1, raw);
      if (removed === 0) return false;
      await this.redis.lpush(this.pendingKey, JSON.stringify(resetForRedrive(entry.message)));
      return true;
    }
    return false;
  }

  async redriveDeadLetters(limit = Number.POSITIVE_INFINITY): Promise<number> {
    await this.connect();
    let moved = 0;
    while (moved < limit) {
      const raw = await this.redis.rpop(this.deadKey);
      if (raw === null) break;
      try {
        const entry: DeadLetterEntry = JSON.parse(raw);
        await this.redis.lpush(this.pendingKey, JSON.stringify(resetForRedrive(entry.message)));
        moved++;
      } catch {
        // Unparseable entry — drop it rather than spinning on it forever.
      }
    }
    return moved;
  }

  async purgeDeadLetters(): Promise<number> {
    await this.connect();
    const n = await this.redis.llen(this.deadKey);
    await this.redis.del(this.deadKey);
    return n;
  }

  async size(): Promise<number> {
    await this.connect();
    const [pendingLen, delayedLen] = await Promise.all([
      this.redis.llen(this.pendingKey),
      this.redis.zcard(this.delayedKey),
    ]);
    return pendingLen + delayedLen;
  }

  /** Number of messages currently leased to a worker. */
  async inFlightSize(): Promise<number> {
    await this.connect();
    return this.redis.llen(this.processingKey);
  }

  /**
   * Reclaim in-flight messages whose lease has expired. Public so a worker can
   * drive reclamation explicitly; also invoked on every pop(). Returns the
   * number of messages reclaimed (re-queued or dead-lettered).
   */
  async reap(): Promise<number> {
    await this.connect();
    // Stage expired leases atomically, then drain staging. Draining first also
    // picks up anything a previously crashed process left parked there.
    await this.redis.eval(REAP_SCRIPT, 3, this.processingKey, this.leasesKey, this.reclaimKey, Date.now().toString());
    return this.drainReclaimed();
  }

  /**
   * Decide what happens to each staged, lease-expired message: a lease expiry
   * counts against the same retry budget as an explicit failure, so a message
   * that keeps outliving its lease is dead-lettered instead of redelivered
   * forever.
   */
  private async drainReclaimed(): Promise<number> {
    const staged = await this.redis.lrange(this.reclaimKey, 0, -1);
    let handled = 0;

    for (const entry of staged) {
      const { raw } = splitEntry(entry);
      let message: QueueMessage;
      try {
        message = JSON.parse(raw);
      } catch {
        // Unparseable payload: drop it from staging rather than blocking the queue.
        await this.redis.lrem(this.reclaimKey, 1, entry);
        continue;
      }

      const now = Date.now();
      const error = `Lease expired after ${this.visibilityTimeoutMs}ms without ack or heartbeat`;
      const failures: TaskFailure[] = [...(message.failures ?? []), { attempt: message.attempt, error, failedAt: now }];
      message.failures = failures;
      message.attempt++;
      message.deliveries = (message.deliveries ?? 0) + 1;
      message.leaseToken = undefined;

      const exhausted = message.attempt > message.maxRetries;
      const destination = exhausted ? this.deadKey : this.pendingKey;
      const payload = exhausted
        ? JSON.stringify({ message, error, failures, deadLetteredAt: now } satisfies DeadLetterEntry)
        : JSON.stringify({ ...message, availableAt: now });

      const drained = (await this.redis.eval(
        DRAIN_RECLAIM_SCRIPT,
        2,
        this.reclaimKey,
        destination,
        entry,
        payload,
      )) as number;
      if (drained === 1) handled++;
    }

    if (handled > 0) await this.redis.ltrim(this.deadKey, 0, this.maxDeadLetters - 1);
    return handled;
  }

  /** Remove the in-flight entry owned by a lease token. Returns the entry, or null. */
  private async releaseLease(leaseToken: string): Promise<string | null> {
    const entry = (await this.redis.eval(
      RELEASE_BY_LEASE_SCRIPT,
      2,
      this.processingKey,
      this.leasesKey,
      `${leaseToken}${LEASE_SEP}`,
    )) as string | null;
    return entry ?? null;
  }

  /** Legacy token-less release: match the in-flight entry by message id. */
  private async releaseById(id: string): Promise<string | null> {
    const entry = await this.findProcessingEntry(id);
    if (!entry) return null;
    const removed = (await this.redis.eval(
      RELEASE_EXACT_SCRIPT,
      2,
      this.processingKey,
      this.leasesKey,
      entry,
    )) as number;
    return removed === 1 ? entry : null;
  }

  /** Find the in-flight entry for a message id (scans the processing list). */
  private async findProcessingEntry(id: string): Promise<string | null> {
    const entries = await this.redis.lrange(this.processingKey, 0, -1);
    for (const entry of entries) {
      try {
        const parsed: QueueMessage = JSON.parse(splitEntry(entry).raw);
        if (parsed.id === id) return entry;
      } catch {
        // Skip unparseable entries
      }
    }
    return null;
  }

  /** Move delayed messages whose availableAt has passed to the pending list */
  private async promoteDelayed(): Promise<number> {
    const moved = (await this.redis.eval(
      PROMOTE_SCRIPT,
      2,
      this.delayedKey,
      this.pendingKey,
      Date.now().toString(),
      PROMOTE_BATCH.toString(),
    )) as number;
    return moved;
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
    await this.redis.del(
      this.pendingKey,
      this.processingKey,
      this.leasesKey,
      this.delayedKey,
      this.reclaimKey,
      this.deadKey,
    );
  }
}

/** Split an in-flight entry into its lease token and raw payload. */
function splitEntry(entry: string): { leaseToken: string; raw: string } {
  const idx = entry.indexOf(LEASE_SEP);
  if (idx === -1) return { leaseToken: "", raw: entry };
  return { leaseToken: entry.slice(0, idx), raw: entry.slice(idx + 1) };
}

/** Reset retry bookkeeping so a re-driven job starts from a clean slate. */
function resetForRedrive(message: QueueMessage): QueueMessage {
  return { ...message, attempt: 0, deliveries: 0, leaseToken: undefined, availableAt: Date.now() };
}
