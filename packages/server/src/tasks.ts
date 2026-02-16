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

  const handlers = new Map<string, TaskDefinition>();
  const jobs: InternalJob[] = [];
  const jobMap = new Map<string, InternalJob>();

  let active = 0;
  let running = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stopResolve: (() => void) | null = null;

  function register<T extends TaskPayload>(definition: TaskDefinition<T>): void {
    handlers.set(definition.name, definition as TaskDefinition);
  }

  async function enqueue<T extends TaskPayload>(
    name: string,
    payload: T,
    options?: { delay?: number },
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
      scheduledAt: Date.now() + (options?.delay ?? 0),
      status: 'pending',
    };

    jobs.push(job);
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

    // Initial processing
    processNext();
  }

  async function stop(): Promise<void> {
    running = false;

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    // Wait for active jobs to finish
    if (active > 0) {
      await new Promise<void>(resolve => {
        stopResolve = resolve;
      });
    }
  }

  function processNext(): void {
    if (!running || active >= concurrency) return;

    const now = Date.now();
    const nextJob = jobs.find(j => j.status === 'pending' && j.scheduledAt <= now);
    if (!nextJob) return;

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
  }

  async function processJob(job: InternalJob): Promise<void> {
    const definition = handlers.get(job.name);
    if (!definition) {
      job.status = 'failed';
      job.result = { success: false, error: `No handler for "${job.name}"` };
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

      // Execute with timeout
      const result = await Promise.race([
        definition.handler(taskJob),
        new Promise<TaskResult>((_, reject) =>
          setTimeout(() => reject(new Error('Task timeout')), job.timeoutMs),
        ),
      ]);

      if (result.success) {
        job.status = 'completed';
        job.result = result;
      } else {
        throw new Error(result.error ?? 'Task failed');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (job.attempts < job.maxRetries) {
        // Schedule retry with backoff
        job.status = 'pending';
        job.scheduledAt = Date.now() + job.retryDelayMs * job.attempts;
      } else {
        job.status = 'failed';
        job.result = { success: false, error: errorMessage };
      }
    }
  }

  function stats(): QueueStats {
    let pending = 0, activeCount = 0, completed = 0, failed = 0;
    for (const job of jobs) {
      switch (job.status) {
        case 'pending': pending++; break;
        case 'active': activeCount++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
      }
    }
    return { pending, active: activeCount, completed, failed, total: jobs.length };
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
