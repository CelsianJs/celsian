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

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr!, 10);
      const start = range === "*" ? min : parseInt(range!, 10);
      for (let i = start; i <= max; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
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

  private tick(): void {
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();

    // Only fire once per minute
    if (currentMinute === this.lastMinute) return;
    this.lastMinute = currentMinute;

    for (const { job, parsed } of this.jobs) {
      if (shouldRun(parsed, now)) {
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
