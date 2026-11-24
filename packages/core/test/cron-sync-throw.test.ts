// @celsian/core -- a cron job that throws synchronously must not escape the timer
//
// tick() ran each job as `Promise.resolve(job.handler()).catch(...)`. That only
// catches a rejection: a handler that throws synchronously throws before
// Promise.resolve() is called. The throw left tick(), so the remaining jobs due
// in that minute did not run, and then left the setInterval callback as an
// uncaught exception. Under serve() that is a shutdown with exit code 1.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { CronScheduler } from "../src/cron.js";

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T10:00:00.500Z"));
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CronScheduler with a job that throws synchronously", () => {
  it("reports the throw and still runs the other jobs due in the same tick", async () => {
    const boom = new Error("sync boom");
    const ran: string[] = [];
    const scheduler = new CronScheduler();
    scheduler.add({ name: "before", schedule: "* * * * *", handler: () => void ran.push("before") });
    scheduler.add({
      name: "bad",
      schedule: "* * * * *",
      handler: () => {
        throw boom;
      },
    });
    scheduler.add({ name: "after", schedule: "* * * * *", handler: () => void ran.push("after") });
    scheduler.start();

    try {
      // Before the fix this rejected: the throw came out of the timer callback.
      await vi.advanceTimersByTimeAsync(1_000);

      expect(ran).toEqual(["before", "after"]);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith("[celsian] Cron job error:", boom);
    } finally {
      scheduler.stop();
    }
  });

  it("reports a synchronous throw exactly as it reports a rejection", async () => {
    const thrown = new Error("thrown");
    const rejected = new Error("rejected");
    const scheduler = new CronScheduler();
    scheduler.add({
      name: "throws",
      schedule: "* * * * *",
      handler: () => {
        throw thrown;
      },
    });
    scheduler.add({ name: "rejects", schedule: "* * * * *", handler: () => Promise.reject(rejected) });
    scheduler.add({
      name: "async-throws",
      schedule: "* * * * *",
      handler: async () => {
        throw rejected;
      },
    });
    scheduler.start();

    try {
      await vi.advanceTimersByTimeAsync(1_000);

      expect(consoleError.mock.calls).toEqual([
        ["[celsian] Cron job error:", thrown],
        ["[celsian] Cron job error:", rejected],
        ["[celsian] Cron job error:", rejected],
      ]);
    } finally {
      scheduler.stop();
    }
  });

  it("keeps the scheduler running: every job fires again the next minute", async () => {
    let good = 0;
    let bad = 0;
    const scheduler = new CronScheduler();
    scheduler.add({
      name: "bad",
      schedule: "* * * * *",
      handler: () => {
        bad++;
        throw new Error("sync boom");
      },
    });
    scheduler.add({ name: "good", schedule: "* * * * *", handler: () => void good++ });
    scheduler.start();

    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect([bad, good]).toEqual([1, 1]);

      await vi.advanceTimersByTimeAsync(60_000);
      expect([bad, good]).toEqual([2, 2]);
      expect(scheduler.isRunning).toBe(true);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.stop();
    }
  });
});

describe("serve() with a cron job that throws synchronously", () => {
  it("keeps the process alive and serving", async () => {
    // A real process and a real timer: the failure was an uncaughtException,
    // which fake timers turn into an ordinary rejection.
    vi.useRealTimers();
    const fixture = fileURLToPath(new URL("./fixtures/cron-sync-throw.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", fixture], { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);

    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }

    // Before the fix: exit code 1 and "uncaughtException, shutting down".
    expect(stderr).not.toContain("uncaughtException");
    expect(code, stderr).toBe(0);
    expect(stderr).toContain("[celsian] Cron job error:");
    expect(stderr).toContain("sync boom");
    const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { goodRuns: number; health: number };
    expect(result.goodRuns).toBeGreaterThanOrEqual(1);
    expect(result.health).toBe(200);
  }, 60_000);
});
