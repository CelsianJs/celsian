// @celsian/core, Cron cannot work on request-scoped serverless runtimes

import { afterEach, describe, expect, it, vi } from "vitest";
import { CronScheduler, detectServerlessCronRuntime } from "../src/cron.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("detectServerlessCronRuntime", () => {
  it("returns null on a normal long-lived Node process", () => {
    expect(detectServerlessCronRuntime()).toBeNull();
  });

  it("detects AWS Lambda and names EventBridge as the alternative", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "my-fn";
    const runtime = detectServerlessCronRuntime();
    expect(runtime?.platform).toBe("AWS Lambda");
    expect(runtime?.alternative).toContain("EventBridge");
  });

  it("detects Vercel Functions", () => {
    process.env.VERCEL = "1";
    expect(detectServerlessCronRuntime()?.platform).toBe("Vercel Functions");
  });

  it("detects Cloudflare Workers by its navigator userAgent", () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const runtime = detectServerlessCronRuntime();
    expect(runtime?.platform).toBe("Cloudflare Workers");
    expect(runtime?.alternative).toContain("Cron Trigger");
    vi.unstubAllGlobals();
  });
});

describe("CronScheduler serverless warning", () => {
  it("warns loudly, naming the jobs that will never fire", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "my-fn";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const scheduler = new CronScheduler();
    scheduler.add({ name: "nightly-report", schedule: "0 3 * * *", handler: () => {} });
    scheduler.start();
    scheduler.stop();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("AWS Lambda");
    expect(message).toContain("nightly-report");
    expect(message).toContain("EventBridge");
  });

  it("does not warn twice across restarts", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "my-fn";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const scheduler = new CronScheduler();
    scheduler.add({ name: "job", schedule: "* * * * *", handler: () => {} });
    scheduler.start();
    scheduler.stop();
    scheduler.start();
    scheduler.stop();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays silent when there are no jobs, and on a normal runtime", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    process.env.AWS_LAMBDA_FUNCTION_NAME = "my-fn";
    const empty = new CronScheduler();
    empty.start();
    empty.stop();

    process.env = { ...originalEnv };
    const normal = new CronScheduler();
    normal.add({ name: "job", schedule: "* * * * *", handler: () => {} });
    normal.start();
    normal.stop();

    expect(warn).not.toHaveBeenCalled();
  });
});
