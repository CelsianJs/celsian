// @celsian/core — Security and reliability improvement tests

import { afterEach, describe, expect, it, vi } from "vitest";
import { CelsianError } from "../src/errors.js";
import { runHooksFireAndForget } from "../src/hooks.js";
import { createLogger } from "../src/logger.js";
import { cors } from "../src/plugins/cors.js";
import { MemoryQueue } from "../src/queue.js";
import { createReply } from "../src/reply.js";
import { buildRequest } from "../src/request.js";
import { createSSEHub } from "../src/sse.js";
import { CronScheduler } from "../src/cron.js";
import { TaskRegistry, TaskWorker } from "../src/task.js";

function makeRequest(url = "http://localhost/test") {
  const request = new Request(url);
  return buildRequest(request, new URL(url), {});
}

// ─── 1. CORS: wildcard + credentials throws ───

describe("CORS wildcard + credentials", () => {
  it("should throw CelsianError when origin is '*' and credentials is true", () => {
    expect(() => cors({ origin: "*", credentials: true })).toThrow(CelsianError);
    expect(() => cors({ origin: "*", credentials: true })).toThrow(
      'CORS misconfiguration: origin "*" with credentials:true is forbidden by browsers.',
    );
  });

  it("should not throw when origin is specific and credentials is true", () => {
    expect(() => cors({ origin: "http://localhost:3000", credentials: true })).not.toThrow();
  });

  it("should not throw when origin is '*' and credentials is false", () => {
    expect(() => cors({ origin: "*", credentials: false })).not.toThrow();
  });

  it("should not throw with default options (origin '*', credentials false)", () => {
    expect(() => cors()).not.toThrow();
  });
});

// ─── 2. Redirect URL validation ───

describe("Redirect URL validation", () => {
  it("should allow relative paths starting with /", () => {
    const reply = createReply();
    const response = reply.redirect("/dashboard");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
  });

  it("should allow http:// URLs", () => {
    const reply = createReply();
    const response = reply.redirect("http://example.com/page");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://example.com/page");
  });

  it("should allow https:// URLs", () => {
    const reply = createReply();
    const response = reply.redirect("https://example.com/page");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/page");
  });

  it("should throw on javascript: URLs", () => {
    const reply = createReply();
    expect(() => reply.redirect("javascript:alert(1)")).toThrow(CelsianError);
    expect(() => reply.redirect("javascript:alert(1)")).toThrow(
      'Invalid redirect URL: "javascript:alert(1)"',
    );
  });

  it("should throw on data: URLs", () => {
    const reply = createReply();
    expect(() => reply.redirect("data:text/html,<h1>XSS</h1>")).toThrow(CelsianError);
  });

  it("should throw on protocol-less URLs", () => {
    const reply = createReply();
    expect(() => reply.redirect("//evil.com/phish")).toThrow(CelsianError);
  });

  it("should throw on ftp: URLs", () => {
    const reply = createReply();
    expect(() => reply.redirect("ftp://evil.com/file")).toThrow(CelsianError);
  });
});

// ─── 3. PATH_TRAVERSAL → FORBIDDEN code ───

describe("sendFile path traversal returns FORBIDDEN code", () => {
  it("should return code FORBIDDEN (not PATH_TRAVERSAL) for traversal attempts", async () => {
    const reply = createReply();
    const response = await reply.sendFile("../../etc/passwd", { root: "/tmp/safe" });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(body.code).not.toBe("PATH_TRAVERSAL");
  });
});

// ─── 4. SSE auto-close on idle ───

describe("SSE hub auto-close idle channels", () => {
  it("should close channels that exceed maxIdleMs", async () => {
    const hub = createSSEHub({ maxIdleMs: 100, cleanupIntervalMs: 50 });

    const req = new Request("http://localhost/events");
    const channel = hub.subscribe(req);

    expect(hub.size).toBe(1);
    expect(channel.open).toBe(true);

    // Wait for the channel to exceed maxIdleMs and cleanup to run
    await new Promise((r) => setTimeout(r, 250));

    expect(channel.open).toBe(false);
    expect(hub.size).toBe(0);

    hub.closeAll();
  });

  it("should not close channels that are actively sending", async () => {
    const hub = createSSEHub({ maxIdleMs: 150, cleanupIntervalMs: 50 });

    const req = new Request("http://localhost/events");
    const channel = hub.subscribe(req);

    // Send data to keep channel alive
    setTimeout(() => channel.send({ data: "ping" }), 80);

    // After 120ms the original lastActivity would be stale,
    // but the send at 80ms should have refreshed it
    await new Promise((r) => setTimeout(r, 120));

    expect(channel.open).toBe(true);
    expect(hub.size).toBe(1);

    hub.closeAll();
  });

  it("should stop cleanup timer on closeAll", async () => {
    const hub = createSSEHub({ maxIdleMs: 100, cleanupIntervalMs: 50 });

    const req = new Request("http://localhost/events");
    hub.subscribe(req);

    hub.closeAll();
    expect(hub.size).toBe(0);
  });
});

// ─── 5. Cron timer.unref() ───

describe("CronScheduler timer.unref()", () => {
  it("should call unref on the interval timer", () => {
    const scheduler = new CronScheduler();
    scheduler.add({
      name: "test",
      schedule: "* * * * *",
      handler: () => {},
    });

    // Spy on setInterval to capture the returned timer
    const originalSetInterval = globalThis.setInterval;
    let timerRef: ReturnType<typeof setInterval> | null = null;
    const unrefSpy = vi.fn();
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      timerRef = originalSetInterval(...args);
      const originalUnref = timerRef.unref?.bind(timerRef);
      timerRef.unref = (...uArgs: []) => {
        unrefSpy();
        return originalUnref?.(...uArgs) ?? timerRef!;
      };
      return timerRef;
    }) as typeof setInterval;

    try {
      scheduler.start();
      expect(unrefSpy).toHaveBeenCalled();
    } finally {
      scheduler.stop();
      globalThis.setInterval = originalSetInterval;
    }
  });
});

// ─── 6. Task worker stop timeout ───

describe("TaskWorker stop timeout", () => {
  it("should resolve stop() even when tasks are still running", async () => {
    const warnings: string[] = [];
    const logger = createLogger({
      destination: (line: string) => {
        const parsed = JSON.parse(line);
        if (parsed.level === "warn") warnings.push(parsed.msg);
      },
    });
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();

    registry.register({
      name: "long-task",
      handler: async () => {
        // Simulate a task that takes a very long time
        await new Promise((r) => setTimeout(r, 60_000));
      },
    });

    await queue.push({
      id: "long-1",
      taskName: "long-task",
      input: {},
      attempt: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      availableAt: Date.now(),
    });

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();

    // Let the worker pick up the task
    await new Promise((r) => setTimeout(r, 150));

    // Stop with a short timeout — should not wait forever
    const startTime = Date.now();
    await worker.stop(200);
    const elapsed = Date.now() - startTime;

    // Should have resolved within timeout + some margin
    expect(elapsed).toBeLessThan(1000);

    // Should have logged a warning about active jobs
    expect(warnings.some((w) => w.includes("active jobs remaining"))).toBe(true);
  });

  it("should resolve immediately if no active jobs", async () => {
    const logger = createLogger({ destination: () => {} });
    const queue = new MemoryQueue();
    const registry = new TaskRegistry();

    const worker = new TaskWorker(registry, queue, logger, { pollInterval: 50 });
    worker.start();

    await new Promise((r) => setTimeout(r, 100));

    const startTime = Date.now();
    await worker.stop(1000);
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(200);
  });
});

// ─── 7. Structured logging for fire-and-forget hooks ───

describe("runHooksFireAndForget structured logging", () => {
  it("should use logger when provided", async () => {
    const loggedErrors: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      error: (msg: string, meta?: Record<string, unknown>) => {
        loggedErrors.push({ msg, meta });
      },
    };

    const hooks = [
      async () => {
        throw new Error("async hook failure");
      },
    ];

    runHooksFireAndForget(hooks as any[], makeRequest(), createReply(), logger);

    // Wait for the async catch to fire
    await new Promise((r) => setTimeout(r, 50));

    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0].msg).toBe("fire-and-forget hook error");
    expect(loggedErrors[0].meta?.error).toBe("async hook failure");
  });

  it("should fall back to console.error when no logger provided", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const hooks = [
      async () => {
        throw new Error("fallback test");
      },
    ];

    runHooksFireAndForget(hooks as any[], makeRequest(), createReply());

    await new Promise((r) => setTimeout(r, 50));

    expect(consoleSpy).toHaveBeenCalledWith("[celsian] fire-and-forget hook error:", expect.any(Error));
    consoleSpy.mockRestore();
  });
});
