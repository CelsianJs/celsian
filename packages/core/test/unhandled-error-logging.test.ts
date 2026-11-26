// @celsian/core -- a server fault must leave a trace when no logger is configured
//
// `createApp()` with no `logger` option uses a silent no-op logger. In
// production the 500 body is sanitized too, so a thrown error was recorded
// nowhere: the client saw "Internal Server Error" and stderr stayed empty.

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { HttpError } from "../src/errors.js";
import type { Logger } from "../src/logger.js";

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A logger that records what reaches it, level by level. */
function recordingLogger(): { logger: Logger; calls: Array<{ level: string; msg: string; data: unknown }> } {
  const calls: Array<{ level: string; msg: string; data: unknown }> = [];
  const at = (level: string) => (msg: string, data?: unknown) => {
    calls.push({ level, msg, data });
  };
  const logger = {
    level: "info",
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("fatal"),
    child: () => logger,
  } as unknown as Logger;
  return { logger, calls };
}

describe("no logger configured", () => {
  it("writes a thrown error to console.error in production, where the response hides it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const boom = new Error("db connection refused at 10.0.0.5");
    const app = createApp();
    app.get("/boom", () => {
      throw boom;
    });

    const res = await app.inject({ url: "/boom?token=s3cret" });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Internal Server Error",
      statusCode: 500,
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [line, logged] = consoleError.mock.calls[0] ?? [];
    // The error object itself, so the stack and any `cause` are printed.
    expect(logged).toBe(boom);
    expect(line).toBe("[celsian] GET /boom failed with 500:");
    // The query string can carry credentials and stays out of the log line.
    expect(String(line)).not.toContain("s3cret");
  });

  it("writes it in development too, so the stack shows up in the terminal", async () => {
    const app = createApp();
    app.post("/boom", async () => {
      throw new TypeError("cannot read properties of undefined");
    });

    const res = await app.inject({ method: "POST", url: "/boom", payload: {} });

    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toBe("[celsian] POST /boom failed with 500:");
    expect(consoleError.mock.calls[0]?.[1]).toMatchObject({ message: "cannot read properties of undefined" });
  });

  it("writes a thrown non-Error value", async () => {
    const app = createApp();
    app.get("/boom", () => {
      throw "plain string";
    });

    const res = await app.inject({ url: "/boom" });

    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("writes an intentional 5xx HttpError, whose message the production response also hides", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const app = createApp();
    app.get("/down", () => {
      throw new HttpError(503, "replica lag on db-7");
    });

    const res = await app.inject({ url: "/down" });

    expect(res.status).toBe(503);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toBe("[celsian] GET /down failed with 503:");
  });

  it("does not write intentional 4xx errors", async () => {
    const app = createApp();
    app.get("/missing", () => {
      throw new HttpError(404, "No such user");
    });
    app.get("/forbidden", (_req, reply) => reply.forbidden("Admins only"));
    app.post("/validated", { schema: { body: z.object({ name: z.string() }) } }, (req) => req.parsedBody);

    expect((await app.inject({ url: "/missing" })).status).toBe(404);
    expect((await app.inject({ url: "/forbidden" })).status).toBe(403);
    expect((await app.inject({ method: "POST", url: "/validated", payload: { name: 5 } })).status).toBe(400);
    expect((await app.inject({ url: "/no-such-route" })).status).toBe(404);

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("stays quiet when the app's own error handler or onError hook answered", async () => {
    const handled = createApp();
    handled.setErrorHandler(() => new Response("handled", { status: 500 }));
    handled.get("/boom", () => {
      throw new Error("handled elsewhere");
    });

    const hooked = createApp();
    hooked.addHook("onError", () => new Response("hooked", { status: 500 }));
    hooked.get("/boom", () => {
      throw new Error("handled elsewhere");
    });

    expect(await (await handled.inject({ url: "/boom" })).text()).toBe("handled");
    expect(await (await hooked.inject({ url: "/boom" })).text()).toBe("hooked");
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("logger configured", () => {
  it("logs a thrown error once, through the logger, and not to console.error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { logger, calls } = recordingLogger();
    const app = createApp({ logger });
    app.get("/boom", () => {
      throw new Error("db connection refused at 10.0.0.5");
    });

    const res = await app.inject({ url: "/boom" });

    expect(res.status).toBe(500);
    expect(consoleError).not.toHaveBeenCalled();
    const errors = calls.filter((call) => call.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toBe("request error");
    expect(errors[0]?.data).toMatchObject({ statusCode: 500, error: "db connection refused at 10.0.0.5" });
  });
});
