import { describe, expect, it, vi } from "vitest";
import { CronScheduler, parseCronExpression, shouldRun } from "../src/cron.js";

describe("Cron Expression Parser", () => {
  it("should parse * (every)", () => {
    const parsed = parseCronExpression("* * * * *");
    expect(parsed.minutes.size).toBe(60);
    expect(parsed.hours.size).toBe(24);
  });

  it("should parse specific values", () => {
    const parsed = parseCronExpression("30 9 * * *");
    expect(parsed.minutes).toEqual(new Set([30]));
    expect(parsed.hours).toEqual(new Set([9]));
  });

  it("should parse ranges", () => {
    const parsed = parseCronExpression("0-5 * * * *");
    expect(parsed.minutes).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it("should parse steps", () => {
    const parsed = parseCronExpression("*/15 * * * *");
    expect(parsed.minutes).toEqual(new Set([0, 15, 30, 45]));
  });

  it("should parse comma-separated values", () => {
    const parsed = parseCronExpression("0,30 * * * *");
    expect(parsed.minutes).toEqual(new Set([0, 30]));
  });

  it("should parse complex expressions", () => {
    const parsed = parseCronExpression("0 */6 * * 1-5");
    expect(parsed.minutes).toEqual(new Set([0]));
    expect(parsed.hours).toEqual(new Set([0, 6, 12, 18]));
    expect(parsed.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("should throw on invalid expression", () => {
    expect(() => parseCronExpression("invalid")).toThrow();
    expect(() => parseCronExpression("* * *")).toThrow();
  });
});

describe("shouldRun", () => {
  it("should match every minute", () => {
    const parsed = parseCronExpression("* * * * *");
    const now = new Date();
    expect(shouldRun(parsed, now)).toBe(true);
  });

  it("should match specific time", () => {
    const parsed = parseCronExpression("30 9 * * *");
    const date = new Date("2025-06-15T09:30:00");
    expect(shouldRun(parsed, date)).toBe(true);
  });

  it("should not match wrong time", () => {
    const parsed = parseCronExpression("30 9 * * *");
    const date = new Date("2025-06-15T10:30:00");
    expect(shouldRun(parsed, date)).toBe(false);
  });

  it("should match day of week", () => {
    const parsed = parseCronExpression("0 0 * * 0"); // Sunday
    const sunday = new Date("2025-06-15T00:00:00"); // June 15 2025 = Sunday
    expect(shouldRun(parsed, sunday)).toBe(true);

    const monday = new Date("2025-06-16T00:00:00");
    expect(shouldRun(parsed, monday)).toBe(false);
  });
});

describe("CronScheduler", () => {
  it("should add and list jobs", () => {
    const scheduler = new CronScheduler();
    scheduler.add({
      name: "test",
      schedule: "* * * * *",
      handler: () => {},
    });

    const jobs = scheduler.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("test");
  });

  it("should start and stop", () => {
    const scheduler = new CronScheduler();
    scheduler.add({
      name: "test",
      schedule: "* * * * *",
      handler: () => {},
    });

    scheduler.start();
    scheduler.stop();
  });

  it("should register cron jobs via app", async () => {
    const { createApp } = await import("../src/app.js");
    const app = createApp();
    let _called = false;

    app.cron("test-job", "* * * * *", () => {
      _called = true;
    });

    const jobs = app.getCronJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("test-job");
  });
});

describe("CronScheduler same-minute dedupe (CORE-10)", () => {
  it("never fires a job twice within the same minute, even if the minute guard resets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00.500Z"));
    try {
      let count = 0;
      const scheduler = new CronScheduler();
      scheduler.add({
        name: "every-minute",
        schedule: "* * * * *",
        handler: () => {
          count++;
        },
      });
      scheduler.start();

      // 30 one-second ticks inside the 10:00 minute -> exactly one fire
      await vi.advanceTimersByTimeAsync(30_000);
      expect(count).toBe(1);

      // Simulate the observed double-fire: the scheduler-level minute guard is
      // defeated mid-minute (restart/race). The per-job guard must still hold.
      (scheduler as unknown as { lastMinute: number }).lastMinute = -1;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(count).toBe(1);

      // Restarting mid-minute must not re-fire either
      scheduler.stop();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(count).toBe(1);

      // The next minute fires exactly once more
      await vi.advanceTimersByTimeAsync(60_000);
      expect(count).toBe(2);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedupes per job, not globally — both jobs still fire in the minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T11:00:00.500Z"));
    try {
      const fired: string[] = [];
      const scheduler = new CronScheduler();
      scheduler.add({
        name: "a",
        schedule: "* * * * *",
        handler: () => {
          fired.push("a");
        },
      });
      scheduler.add({
        name: "b",
        schedule: "* * * * *",
        handler: () => {
          fired.push("b");
        },
      });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(fired.sort()).toEqual(["a", "b"]);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
