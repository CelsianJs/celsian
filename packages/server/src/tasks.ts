// @celsian/server — Background task queue and cron scheduler

export interface TaskPayload {
  [key: string]: unknown;
}

export interface TaskJob<T extends TaskPayload = TaskPayload> {
  /** Unique job ID */
  readonly id: string;
  /** Task name */
  readonly name: string;
  /** Job payload */
  readonly payload: T;
  /** Number of attempts so far */
  readonly attempts: number;
  /** When the job was created */
  readonly createdAt: number;
}

export interface TaskResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export type TaskHandler<T extends TaskPayload = TaskPayload> = (
  job: TaskJob<T>,
) => TaskResult | Promise<TaskResult>;

export interface TaskDefinition<T extends TaskPayload = TaskPayload> {
  /** Task name (used to route jobs to handlers) */
  name: string;
  /** Handler function */
  handler: TaskHandler<T>;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Retry delay in ms (default: 1000). Multiplied by attempt number. */
  retryDelayMs?: number;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
}

export interface TaskQueueOptions {
  /** Concurrency — how many jobs to process simultaneously (default: 1) */
  concurrency?: number;
  /** Poll interval in ms for checking new jobs (default: 100) */
  pollIntervalMs?: number;
  /** How long to retain completed/failed jobs before eviction, in ms (default: 3600000 = 1 hour) */
  retentionMs?: number;
  /** Max completed/failed jobs to keep in memory (default: 10000) */
  maxRetainedJobs?: number;
}

export interface TaskQueue {
  /** Register a task handler */
  register<T extends TaskPayload>(definition: TaskDefinition<T>): void;
  /** Enqueue a job for processing */
  enqueue<T extends TaskPayload>(name: string, payload: T, options?: { delay?: number }): Promise<string>;
  /** Start processing jobs */
  start(): void;
  /** Stop processing (waits for in-flight jobs to finish) */
  stop(): Promise<void>;
  /** Get queue stats */
  stats(): QueueStats;
  /** Get a job by ID */
  getJob(id: string): TaskJob | undefined;
}

export interface QueueStats {
  pending: number;
  active: number;
  completed: number;
  failed: number;
  total: number;
}

interface InternalJob {
  id: string;
  name: string;
  payload: TaskPayload;
  attempts: number;
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  createdAt: number;
  scheduledAt: number;
  status: 'pending' | 'active' | 'completed' | 'failed';
  result?: TaskResult;
}

/**
 * Generate a unique job ID.
 */
function generateJobId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create an in-memory task queue.
 *
 * Usage:
 * ```ts
 * const queue = createTaskQueue({ concurrency: 4 });
 *
 * queue.register({
 *   name: 'send-email',
 *   handler: async (job) => {
 *     await sendEmail(job.payload.to, job.payload.subject);
 *     return { success: true };
 *   },
 *   maxRetries: 3,
 * });
 *
 * queue.start();
 *
 * // Enqueue jobs from route handlers
 * app.post('/send', async (req, reply) => {
 *   const jobId = await queue.enqueue('send-email', { to: 'alice@example.com', subject: 'Hello' });
 *   return reply.json({ jobId });
 * });
 * ```
 */
export function createTaskQueue(options?: TaskQueueOptions): TaskQueue {
  const concurrency = options?.concurrency ?? 1;
  const pollIntervalMs = options?.pollIntervalMs ?? 100;
  const retentionMs = options?.retentionMs ?? 3_600_000; // 1 hour
  const maxRetainedJobs = options?.maxRetainedJobs ?? 10_000;

  const handlers = new Map<string, TaskDefinition>();
  const jobMap = new Map<string, InternalJob>();

  // Separate queues for O(1) next-job access instead of O(n) scan
  const pendingJobs: InternalJob[] = [];
  let completedCount = 0;
  let failedCount = 0;

  let active = 0;
  let running = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let evictionTimer: ReturnType<typeof setInterval> | null = null;
  let stopResolve: (() => void) | null = null;

  function register<T extends TaskPayload>(definition: TaskDefinition<T>): void {
    handlers.set(definition.name, definition as TaskDefinition);
  }

  async function enqueue<T extends TaskPayload>(
    name: string,
    payload: T,
    opts?: { delay?: number },
  ): Promise<string> {
    const definition = handlers.get(name);
    if (!definition) {
      throw new Error(`No handler registered for task "${name}"`);
    }

    const job: InternalJob = {
      id: generateJobId(),
      name,
      payload,
      attempts: 0,
      maxRetries: definition.maxRetries ?? 3,
      retryDelayMs: definition.retryDelayMs ?? 1000,
      timeoutMs: definition.timeoutMs ?? 30_000,
      createdAt: Date.now(),
      scheduledAt: Date.now() + (opts?.delay ?? 0),
      status: 'pending',
    };

    pendingJobs.push(job);
    jobMap.set(job.id, job);

    // Trigger processing if running
    if (running) {
      processNext();
    }

    return job.id;
  }

  function start(): void {
    if (running) return;
    running = true;

    pollTimer = setInterval(() => {
      if (running) processNext();
    }, pollIntervalMs);

    if (typeof pollTimer === 'object' && 'unref' in pollTimer) {
      pollTimer.unref();
    }

    // Periodic eviction of completed/failed jobs to prevent memory leaks
    evictionTimer = setInterval(evictStaleJobs, 60_000);
    if (typeof evictionTimer === 'object' && 'unref' in evictionTimer) {
      evictionTimer.unref();
    }

    // Initial processing
    processNext();
  }

  async function stop(): Promise<void> {
    running = false;

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (evictionTimer) {
      clearInterval(evictionTimer);
      evictionTimer = null;
    }

    // Wait for active jobs to finish
    if (active > 0) {
      await new Promise<void>(resolve => {
        stopResolve = resolve;
      });
    }
  }

  /** Evict completed/failed jobs older than retentionMs or exceeding maxRetainedJobs */
  function evictStaleJobs(): void {
    const now = Date.now();
    const cutoff = now - retentionMs;
    let evicted = 0;

    for (const [id, job] of jobMap) {
      if ((job.status === 'completed' || job.status === 'failed') && job.createdAt < cutoff) {
        jobMap.delete(id);
        if (job.status === 'completed') completedCount--;
        else failedCount--;
        evicted++;
      }
    }

    // If still over limit, evict oldest completed/failed jobs
    const terminalCount = completedCount + failedCount;
    if (terminalCount > maxRetainedJobs) {
      const toEvict: InternalJob[] = [];
      for (const job of jobMap.values()) {
        if (job.status === 'completed' || job.status === 'failed') {
          toEvict.push(job);
        }
      }
      toEvict.sort((a, b) => a.createdAt - b.createdAt);
      const removeCount = terminalCount - maxRetainedJobs;
      for (let i = 0; i < removeCount && i < toEvict.length; i++) {
        const job = toEvict[i]!;
        jobMap.delete(job.id);
        if (job.status === 'completed') completedCount--;
        else failedCount--;
      }
    }
  }

  function processNext(): void {
    if (!running || active >= concurrency) return;

    const now = Date.now();
    // O(1) — check front of pending queue
    while (pendingJobs.length > 0) {
      const nextJob = pendingJobs[0]!;
      // Skip jobs that were retried and re-added (status might have changed)
      if (nextJob.status !== 'pending') {
        pendingJobs.shift();
        continue;
      }
      if (nextJob.scheduledAt > now) break; // Not ready yet

      pendingJobs.shift();
      active++;
      nextJob.status = 'active';
      nextJob.attempts++;

      processJob(nextJob).then(() => {
        active--;

        if (!running && active === 0 && stopResolve) {
          stopResolve();
          stopResolve = null;
        }

        // Try to process more
        if (running) processNext();
      });

      // Respect concurrency limit
      if (active >= concurrency) return;
    }
  }

  async function processJob(job: InternalJob): Promise<void> {
    const definition = handlers.get(job.name);
    if (!definition) {
      job.status = 'failed';
      job.result = { success: false, error: `No handler for "${job.name}"` };
      failedCount++;
      return;
    }

    try {
      const taskJob: TaskJob = {
        id: job.id,
        name: job.name,
        payload: job.payload,
        attempts: job.attempts,
        createdAt: job.createdAt,
      };

      // Execute with timeout — properly clear timer to prevent leaks
      let timeoutId: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        definition.handler(taskJob),
        new Promise<TaskResult>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Task timeout')), job.timeoutMs);
        }),
      ]).finally(() => {
        clearTimeout(timeoutId!);
      });

      if (result.success) {
        job.status = 'completed';
        job.result = result;
        completedCount++;
      } else {
        throw new Error(result.error ?? 'Task failed');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (job.attempts < job.maxRetries) {
        // Schedule retry with backoff — re-add to pending queue
        job.status = 'pending';
        job.scheduledAt = Date.now() + job.retryDelayMs * job.attempts;
        pendingJobs.push(job);
      } else {
        job.status = 'failed';
        job.result = { success: false, error: errorMessage };
        failedCount++;
      }
    }
  }

  function stats(): QueueStats {
    return {
      pending: pendingJobs.filter(j => j.status === 'pending').length,
      active,
      completed: completedCount,
      failed: failedCount,
      total: jobMap.size,
    };
  }

  function getJob(id: string): TaskJob | undefined {
    const job = jobMap.get(id);
    if (!job) return undefined;
    return {
      id: job.id,
      name: job.name,
      payload: job.payload,
      attempts: job.attempts,
      createdAt: job.createdAt,
    };
  }

  return { register, enqueue, start, stop, stats, getJob };
}

// ─── Cron Scheduler ───

export interface CronJob {
  /** Unique name for this cron job */
  name: string;
  /** Cron schedule pattern (simplified: supports seconds/minutes/hours/daily) */
  schedule: string | number;
  /** Handler function */
  handler: () => void | Promise<void>;
  /** Whether to run immediately on start (default: false) */
  immediate?: boolean;
}

export interface CronScheduler {
  /** Register a cron job */
  add(job: CronJob): void;
  /** Start all registered cron jobs */
  start(): void;
  /** Stop all cron jobs */
  stop(): void;
  /** Get list of registered jobs */
  list(): Array<{ name: string; schedule: string | number; running: boolean }>;
}

/**
 * Parse a simplified schedule into an interval in milliseconds.
 *
 * Supported formats:
 * - Number: interval in milliseconds
 * - "5s", "30s": seconds
 * - "5m", "30m": minutes
 * - "1h", "12h": hours
 * - "1d": days
 * - "every 5s", "every 30m": same as above with "every" prefix
 */
function parseSchedule(schedule: string | number): number {
  if (typeof schedule === 'number') return schedule;

  const cleaned = schedule.replace(/^every\s+/i, '').trim();
  const match = cleaned.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid schedule format: "${schedule}". Use "5s", "30m", "1h", "1d", or milliseconds.`);
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();

  switch (unit) {
    case 'ms': return value;
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return value;
  }
}

/**
 * Create a cron scheduler for periodic background tasks.
 *
 * Usage:
 * ```ts
 * const cron = createCronScheduler();
 *
 * cron.add({
 *   name: 'cleanup-sessions',
 *   schedule: '1h',
 *   handler: async () => {
 *     await sessionStore.clear('expired:*');
 *   },
 * });
 *
 * cron.add({
 *   name: 'health-check',
 *   schedule: '30s',
 *   immediate: true,
 *   handler: () => console.log('alive'),
 * });
 *
 * cron.start();
 * ```
 */
export function createCronScheduler(): CronScheduler {
  const jobs: Array<CronJob & { timer: ReturnType<typeof setInterval> | null; running: boolean }> = [];

  function add(job: CronJob): void {
    jobs.push({ ...job, timer: null, running: false });
  }

  function start(): void {
    for (const job of jobs) {
      if (job.running) continue;
      job.running = true;

      const intervalMs = parseSchedule(job.schedule);

      if (job.immediate) {
        try {
          const result = job.handler();
          if (result instanceof Promise) {
            result.catch(() => {}); // Swallow errors in cron jobs
          }
        } catch {
          // Swallow
        }
      }

      job.timer = setInterval(() => {
        try {
          const result = job.handler();
          if (result instanceof Promise) {
            result.catch(() => {});
          }
        } catch {
          // Swallow
        }
      }, intervalMs);

      if (typeof job.timer === 'object' && 'unref' in job.timer) {
        job.timer.unref();
      }
    }
  }

  function stop(): void {
    for (const job of jobs) {
      if (job.timer) {
        clearInterval(job.timer);
        job.timer = null;
      }
      job.running = false;
    }
  }

  function list() {
    return jobs.map(j => ({
      name: j.name,
      schedule: j.schedule,
      running: j.running,
    }));
  }

  return { add, start, stop, list };
}
