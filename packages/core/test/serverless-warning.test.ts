// @celsian/core -- Tests for serverless safety warnings

import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

describe("Serverless Safety Warnings", () => {
  it("should warn when enqueuing without a worker", async () => {
    const app = createApp();
    app.task({ name: "test-task", handler: async () => {} });

    const warnSpy = vi.spyOn(app.log, "warn");
    await app.enqueue("test-task", { data: 1 });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no worker is running"),
    );
  });

  it("should only warn once for repeated enqueues without worker", async () => {
    const app = createApp();
    app.task({ name: "test-task", handler: async () => {} });

    const warnSpy = vi.spyOn(app.log, "warn");
    await app.enqueue("test-task", { data: 1 });
    await app.enqueue("test-task", { data: 2 });

    // Filter for the specific warning about no worker
    const workerWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("no worker is running"),
    );
    expect(workerWarnings).toHaveLength(1);
  });

  it("should not warn when worker is running", async () => {
    const app = createApp();
    app.task({ name: "test-task", handler: async () => {} });
    app.startWorker();

    const warnSpy = vi.spyOn(app.log, "warn");
    await app.enqueue("test-task", { data: 1 });

    const workerWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("no worker is running"),
    );
    expect(workerWarnings).toHaveLength(0);

    await app.stopWorker();
  });

  it("should warn when cron jobs registered but scheduler not started on first handle", async () => {
    const app = createApp();
    app.cron("test-cron", "* * * * *", async () => {});

    const warnSpy = vi.spyOn(app.log, "warn");

    // Simulate a serverless request (handle without serve)
    const req = new Request("http://localhost/test");
    app.get("/test", (_req, reply) => reply.json({ ok: true }));
    await app.handle(req);

    const cronWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("scheduler not started"),
    );
    expect(cronWarnings).toHaveLength(1);
  });

  it("should not warn about cron when scheduler is started", async () => {
    const app = createApp();
    app.cron("test-cron", "* * * * *", async () => {});
    app.startCron();

    const warnSpy = vi.spyOn(app.log, "warn");

    const req = new Request("http://localhost/test");
    app.get("/test", (_req, reply) => reply.json({ ok: true }));
    await app.handle(req);

    const cronWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("scheduler not started"),
    );
    expect(cronWarnings).toHaveLength(0);

    app.stopCron();
  });
});
