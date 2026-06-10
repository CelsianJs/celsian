// @celsian/core — Cron scheduling (5-field unix cron, no deps)

import { CelsianError } from "./errors.js";

/** Definition for a cron job: name, schedule expression, and handler function. */
export interface CronJob {
  name: string;
  schedule: string;
  handler: () => Promise<void> | void;
  timezone?: string;
}

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

/** Parse a 5-field unix cron expression into sets of matching values per field. */
export function parseCronExpression(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CelsianError(`Invalid cron expression: "${expr}" (expected 5 fields)`);
  }

  return {
    minutes: parseField(parts[0]!, 0, 59),
    hours: parseField(parts[1]!, 0, 23),
    daysOfMonth: parseField(parts[2]!, 1, 31),
    months: parseField(parts[3]!, 1, 12),
    daysOfWeek: parseField(parts[4]!, 0, 6),
  };
}

/** Parse a single integer field value, rejecting NaN with a clear error. */
function parseIntStrict(raw: string, field: string): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new CelsianError(`Invalid cron field: "${field}" (expected an integer, got "${raw}")`);
  }
  return n;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  const inRange = (n: number): number => {
    if (n < min || n > max) {
      throw new CelsianError(`Invalid cron field: "${field}" (value ${n} out of range [${min}, ${max}])`);
    }
    return n;
  };

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseIntStrict(stepStr!, field);
      if (step <= 0) {
        throw new CelsianError(`Invalid cron field: "${field}" (step must be a positive integer, got ${step})`);
      }
      const start = range === "*" ? min : inRange(parseIntStrict(range!, field));
      for (let i = start; i <= max; i += step) values.add(inRange(i));
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = inRange(parseIntStrict(startStr!, field));
      const end = inRange(parseIntStrict(endStr!, field));
      for (let i = start; i <= end; i++) values.add(inRange(i));
    } else {
      values.add(inRange(parseIntStrict(part, field)));
    }
  }

  return values;
}

/** Check whether a parsed cron expression matches a given date (minute-level). */
export function shouldRun(parsed: ParsedCron, date: Date): boolean {
  return (
    parsed.minutes.has(date.getMinutes()) &&
    parsed.hours.has(date.getHours()) &&
    parsed.daysOfMonth.has(date.getDate()) &&
    parsed.months.has(date.getMonth() + 1) &&
    parsed.daysOfWeek.has(date.getDay())
  );
}

/**
 * Scheduler that ticks every second and fires registered jobs on minute boundaries.
 * Zero external dependencies -- uses a simple interval timer.
 */
export class CronScheduler {
  private jobs: Array<{ job: CronJob; parsed: ParsedCron }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMinute = -1;
  // Per-job double-fire guard: absolute epoch minute each job last fired in.
  // Survives scheduler stop/start within the same minute, unlike lastMinute alone.
  private lastFiredEpochMinute = new Map<string, number>();

  add(job: CronJob): void {
    const parsed = parseCronExpression(job.schedule);
    this.jobs.push({ job, parsed });
  }

  start(): void {
    if (this.timer) return;

    // Tick every second, but only fire jobs on minute boundary
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether the scheduler timer is currently running. */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  private tick(): void {
    const now = new Date();
    // Absolute epoch minute — unlike hours*60+minutes it never repeats across
    // days, so the guard cannot be fooled at day boundaries.
    const epochMinute = Math.floor(now.getTime() / 60_000);

    // Only fire once per minute
    if (epochMinute === this.lastMinute) return;
    this.lastMinute = epochMinute;

    for (const { job, parsed } of this.jobs) {
      if (shouldRun(parsed, now)) {
        // Per-job dedupe: never fire the same job twice within one minute,
        // even if ticks race or the scheduler restarts mid-minute.
        if (this.lastFiredEpochMinute.get(job.name) === epochMinute) continue;
        this.lastFiredEpochMinute.set(job.name, epochMinute);
        // Fire and forget — log errors instead of silently swallowing
        Promise.resolve(job.handler()).catch((err) => {
          console.error("[celsian] Cron job error:", err);
        });
      }
    }
  }

  getJobs(): CronJob[] {
    return this.jobs.map((j) => j.job);
  }
}
