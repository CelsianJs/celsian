// @celsian/core, Queue backend interface + in-memory implementation

/** Default visibility timeout: how long a popped message stays leased to one worker. */
export const DEFAULT_VISIBILITY_TIMEOUT = 30_000;

/** A single failed execution attempt, recorded so a dead-lettered job is auditable. */
export interface TaskFailure {
  /** Zero-based attempt number that failed. */
  attempt: number;
  /** Error message from that attempt. */
  error: string;
  /** Epoch ms when the attempt failed. */
  failedAt: number;
}

export interface QueueMessage {
  id: string;
  taskName: string;
  input: unknown;
  attempt: number;
  maxRetries: number;
  createdAt: number;
  availableAt: number;
  /**
   * How many times this message has been handed to a worker, including
   * redeliveries after a lease expired. Distinct from `attempt`, which only
   * counts deliveries that ended in an explicit failure (nack).
   */
  deliveries?: number;
  /**
   * Token identifying the current delivery. Assigned by the backend on `pop()`.
   * `ack`/`nack`/`extend` only affect the in-flight entry whose token matches,
   * so a worker whose lease already expired can never clobber the worker that
   * subsequently picked the message up.
   */
  leaseToken?: string;
  /** Failure history accumulated across attempts. */
  failures?: TaskFailure[];
}

/** A job that exhausted its retries (or its redeliveries), kept for inspection and re-drive. */
export interface DeadLetterEntry {
  message: QueueMessage;
  /** The final error that caused the job to be dead-lettered. */
  error: string;
  /** Every recorded failure, oldest first. */
  failures: TaskFailure[];
  deadLetteredAt: number;
}

/**
 * Optional dead-letter surface. Backends that implement it never destroy a
 * permanently-failed job; the task worker routes such jobs here instead of
 * acking them into the void.
 */
export interface DeadLetterCapableQueue {
  /**
   * Move a permanently-failed job to the dead-letter queue. Implementations must
   * also release the in-flight entry identified by `leaseToken`.
   */
  deadLetter(entry: DeadLetterEntry, leaseToken?: string): Promise<void>;
  /** List dead-lettered jobs, newest first. */
  listDeadLetters(limit?: number): Promise<DeadLetterEntry[]>;
  /** Re-queue a single dead-lettered job by message id. Returns whether it was found. */
  redriveDeadLetter(id: string): Promise<boolean>;
  /** Re-queue dead-lettered jobs. Returns how many were re-queued. */
  redriveDeadLetters(limit?: number): Promise<number>;
  /** Permanently discard all dead-lettered jobs. Returns how many were discarded. */
  purgeDeadLetters(): Promise<number>;
  /** Number of jobs currently in the dead-letter queue. */
  deadLetterSize(): Promise<number>;
}

export interface QueueBackend extends Partial<DeadLetterCapableQueue> {
  push(message: QueueMessage): Promise<void>;
  pop(): Promise<QueueMessage | null>;
  /** Remove an in-flight message. When `leaseToken` is given it must match the current lease. */
  ack(id: string, leaseToken?: string): Promise<void>;
  /** Return a failed message for retry. When `leaseToken` is given it must match the current lease. */
  nack(id: string, delay?: number, leaseToken?: string, failure?: TaskFailure): Promise<void>;
  size(): Promise<number>;
  /**
   * Optional heartbeat: push the lease expiry out so a long-running task keeps
   * ownership of its message. Returns false when the lease is no longer held
   * (the message was already reclaimed by another worker).
   */
  extend?(id: string, leaseToken: string, extraMs?: number): Promise<boolean>;
  /**
   * Optional: the backend's visibility timeout in ms. The task worker uses this
   * to reject task timeouts that would guarantee duplicate concurrent execution.
   */
  readonly visibilityTimeoutMs?: number;
}

export function generateQueueId(): string {
  return crypto.randomUUID();
}

export interface MemoryQueueOptions {
  /** Maximum number of completed job IDs to track. Oldest are evicted first. Default: 1000 */
  maxCompletedJobs?: number;
  /**
   * How long a popped message stays leased before it is reclaimed and redelivered.
   * Default: 30000
   */
  visibilityTimeout?: number;
  /** Maximum dead-letter entries retained. Oldest are evicted first. Default: 1000 */
  maxDeadLetters?: number;
}

interface InFlightEntry {
  message: QueueMessage;
  leaseToken: string;
  expiresAt: number;
}

/**
 * In-process queue backend. **Durability characteristics, stated honestly:**
 *
 * - At-least-once *within a single process*: a message whose lease expires
 *   (worker hung, crashed mid-task, or exceeded the visibility timeout without
 *   heartbeating) is reclaimed on the next `pop()` and redelivered.
 * - **It cannot survive a process crash or restart.** Everything lives in
 *   JavaScript memory. If the process dies, every pending, delayed, in-flight
 *   and dead-lettered job dies with it. There is no fsync, no WAL, no replica.
 * - It is **single-process only**. Two Node processes each get their own
 *   independent queue; they do not share work.
 *
 * This is the right default for development and for single-instance apps whose
 * jobs are cheap to lose. Anything that must survive a deploy, a crash, or that
 * runs on more than one instance needs a durable backend such as
 * `@celsian/queue-redis`.
 */
export class MemoryQueue implements QueueBackend, DeadLetterCapableQueue {
  private messages: QueueMessage[] = [];
  private inFlight = new Map<string, InFlightEntry>();
  private dead: DeadLetterEntry[] = [];
  private completed: string[] = [];
  private readonly maxCompletedJobs: number;
  private readonly maxDeadLetters: number;
  readonly visibilityTimeoutMs: number;

  constructor(options: MemoryQueueOptions = {}) {
    this.maxCompletedJobs = options.maxCompletedJobs ?? 1000;
    this.maxDeadLetters = options.maxDeadLetters ?? 1000;
    this.visibilityTimeoutMs = options.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT;
  }

  async push(message: QueueMessage): Promise<void> {
    this.messages.push(message);
  }

  async pop(): Promise<QueueMessage | null> {
    this.reclaimExpired();

    const now = Date.now();
    const idx = this.messages.findIndex((m) => m.availableAt <= now);
    if (idx === -1) return null;

    const [message] = this.messages.splice(idx, 1) as [QueueMessage];
    const leaseToken = generateQueueId();
    message.deliveries = (message.deliveries ?? 0) + 1;
    message.leaseToken = leaseToken;
    this.inFlight.set(message.id, {
      message,
      leaseToken,
      expiresAt: now + this.visibilityTimeoutMs,
    });
    // Hand out a copy. A durable backend serializes on every delivery, so
    // returning the live object would let a stale worker's view of leaseToken
    // silently follow a later redelivery and defeat the lease check.
    return { ...message };
  }

  async ack(id: string, leaseToken?: string): Promise<void> {
    const entry = this.inFlight.get(id);
    // A stale lease must never remove the entry a later delivery owns.
    if (!entry || (leaseToken !== undefined && entry.leaseToken !== leaseToken)) return;
    this.inFlight.delete(id);
    this.completed.push(id);
    // Evict oldest completed jobs when over limit
    if (this.completed.length > this.maxCompletedJobs) {
      this.completed.splice(0, this.completed.length - this.maxCompletedJobs);
    }
  }

  async nack(id: string, delay = 1000, leaseToken?: string, failure?: TaskFailure): Promise<void> {
    const entry = this.inFlight.get(id);
    if (!entry || (leaseToken !== undefined && entry.leaseToken !== leaseToken)) return;
    this.inFlight.delete(id);
    const message = entry.message;
    message.attempt++;
    message.availableAt = Date.now() + delay;
    message.leaseToken = undefined;
    if (failure) message.failures = [...(message.failures ?? []), failure];
    this.messages.push(message);
  }

  async extend(id: string, leaseToken: string, extraMs?: number): Promise<boolean> {
    const entry = this.inFlight.get(id);
    if (!entry || entry.leaseToken !== leaseToken) return false;
    entry.expiresAt = Date.now() + (extraMs ?? this.visibilityTimeoutMs);
    return true;
  }

  async deadLetter(entry: DeadLetterEntry, leaseToken?: string): Promise<void> {
    const inFlight = this.inFlight.get(entry.message.id);
    if (inFlight && (leaseToken === undefined || inFlight.leaseToken === leaseToken)) {
      this.inFlight.delete(entry.message.id);
    }
    this.pushDead(entry);
  }

  async listDeadLetters(limit = 100): Promise<DeadLetterEntry[]> {
    return this.dead.slice(-limit).reverse();
  }

  async redriveDeadLetter(id: string): Promise<boolean> {
    const idx = this.dead.findIndex((e) => e.message.id === id);
    if (idx === -1) return false;
    const [entry] = this.dead.splice(idx, 1) as [DeadLetterEntry];
    this.messages.push(this.resetForRedrive(entry.message));
    return true;
  }

  async redriveDeadLetters(limit = Number.POSITIVE_INFINITY): Promise<number> {
    const batch = this.dead.splice(0, Math.min(this.dead.length, limit));
    for (const entry of batch) {
      this.messages.push(this.resetForRedrive(entry.message));
    }
    return batch.length;
  }

  async purgeDeadLetters(): Promise<number> {
    const n = this.dead.length;
    this.dead = [];
    return n;
  }

  async deadLetterSize(): Promise<number> {
    return this.dead.length;
  }

  async size(): Promise<number> {
    return this.messages.length;
  }

  /** Number of messages currently leased to a worker. */
  async inFlightSize(): Promise<number> {
    return this.inFlight.size;
  }

  /**
   * Reclaim messages whose lease expired (worker crashed, hung, or ran past the
   * visibility timeout without heartbeating).
   *
   * A lease expiry counts as a failed attempt, so it draws down the same retry
   * budget as an explicit failure. Once that budget is exhausted the message is
   * dead-lettered instead of being redelivered forever, which is what stops a
   * job that reliably outlives its lease from looping as a poison pill.
   */
  private reclaimExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.inFlight) {
      if (entry.expiresAt > now) continue;
      this.inFlight.delete(id);
      const message = entry.message;
      message.leaseToken = undefined;
      const error = `Lease expired after ${this.visibilityTimeoutMs}ms without ack or heartbeat`;
      const failure: TaskFailure = { attempt: message.attempt, error, failedAt: now };
      message.failures = [...(message.failures ?? []), failure];
      message.attempt++;

      if (message.attempt > message.maxRetries) {
        this.pushDead({ message, error, failures: message.failures, deadLetteredAt: now });
        continue;
      }
      message.availableAt = now;
      this.messages.push(message);
    }
  }

  private pushDead(entry: DeadLetterEntry): void {
    this.dead.push(entry);
    if (this.dead.length > this.maxDeadLetters) {
      this.dead.splice(0, this.dead.length - this.maxDeadLetters);
    }
  }

  private resetForRedrive(message: QueueMessage): QueueMessage {
    return { ...message, attempt: 0, deliveries: 0, leaseToken: undefined, availableAt: Date.now() };
  }
}
