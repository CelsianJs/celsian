// @celsian/core, serve() process-level behaviour
//
// Covers:
//  - the startup line was logged twice (app.log.info + a bare console.log), which
//    puts a non-JSON line into a JSON log stream on every boot;
//  - serve() handled only SIGTERM/SIGINT, so an unhandled rejection crashed the
//    process with no log line and no drain.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { type ServeResult, serve } from "../src/serve.js";

const servers: ServeResult[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  vi.restoreAllMocks();
});

async function start(app: ReturnType<typeof createApp>, options = {}): Promise<ServeResult> {
  const result = await serve(app, { port: 0, host: "127.0.0.1", handleFatalErrors: false, ...options });
  servers.push(result);
  return result;
}

describe("serve() startup logging", () => {
  it("prints the human-readable line when there is no structured logger", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await start(createApp());

    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Server running at"));
    expect(lines).toHaveLength(1);
  });

  it("does not write a plain-text line into a JSON log stream", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const app = createApp({ logger: true });
    const logged: string[] = [];
    vi.spyOn(app.log, "info").mockImplementation((msg: string) => {
      logged.push(msg);
    });

    await start(app);

    // The structured logger still records it...
    expect(logged.some((l) => l.includes("Server running at"))).toBe(true);
    // ...but the bare console.log duplicate is gone.
    expect(consoleLog.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Server running at"))).toEqual([]);
  });
});

describe("serve() fatal error handlers", () => {
  function listenerCount(event: "unhandledRejection" | "uncaughtException"): number {
    return process.listenerCount(event);
  }

  it("installs unhandledRejection and uncaughtException handlers by default", async () => {
    const before = {
      rejection: listenerCount("unhandledRejection"),
      exception: listenerCount("uncaughtException"),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Registered on the shared process object, so remove them again below.
    const result = await serve(createApp(), { port: 0, host: "127.0.0.1" });
    servers.push(result);

    const rejectionListeners = process.listeners("unhandledRejection");
    const exceptionListeners = process.listeners("uncaughtException");
    expect(rejectionListeners.length).toBe(before.rejection + 1);
    expect(exceptionListeners.length).toBe(before.exception + 1);

    process.removeListener("unhandledRejection", rejectionListeners[rejectionListeners.length - 1]);
    process.removeListener("uncaughtException", exceptionListeners[exceptionListeners.length - 1]);
  });

  it("detaches every process listener it added on close", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const before = {
      rejection: listenerCount("unhandledRejection"),
      exception: listenerCount("uncaughtException"),
      term: process.listenerCount("SIGTERM"),
      int: process.listenerCount("SIGINT"),
    };

    // Starting several servers must not accumulate listeners (MaxListenersExceededWarning).
    for (let i = 0; i < 3; i++) {
      const result = await serve(createApp(), { port: 0, host: "127.0.0.1" });
      await result.close();
    }

    expect(listenerCount("unhandledRejection")).toBe(before.rejection);
    expect(listenerCount("uncaughtException")).toBe(before.exception);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
    expect(process.listenerCount("SIGINT")).toBe(before.int);
  });

  it("can be opted out of with handleFatalErrors: false", async () => {
    const before = listenerCount("unhandledRejection");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await start(createApp());

    expect(listenerCount("unhandledRejection")).toBe(before);
  });

  it("logs the failure and drains before exiting non-zero", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const app = createApp();
    const fatalLogs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    vi.spyOn(app.log, "fatal").mockImplementation((msg: string, meta?: Record<string, unknown>) => {
      fatalLogs.push({ msg, meta });
    });

    let cleaned = false;
    const result = await serve(app, {
      port: 0,
      host: "127.0.0.1",
      onShutdown: () => {
        cleaned = true;
      },
    });
    servers.push(result);

    const listeners = process.listeners("unhandledRejection");
    const handler = listeners[listeners.length - 1] as (reason: unknown) => void;
    try {
      handler(new Error("boom"));
      // Let the async shutdown chain settle.
      await new Promise((r) => setTimeout(r, 50));

      // Never swallowed: logged structurally AND on stderr.
      expect(fatalLogs[0]?.msg).toMatch(/unhandledRejection/);
      expect(fatalLogs[0]?.meta?.error).toBe("boom");
      expect(errorSpy).toHaveBeenCalled();
      // Drained, then exited non-zero.
      expect(cleaned).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      process.removeListener("unhandledRejection", handler);
      const exceptionListeners = process.listeners("uncaughtException");
      process.removeListener("uncaughtException", exceptionListeners[exceptionListeners.length - 1]);
    }
  });
});
