// @celsian/core -- the request timeout is one timer, and request.signal is built on demand
//
// The timeout used to cost every request a Promise.race, a second promise, a
// .finally(), an AbortController and an AbortSignal.any(), whether or not the
// handler ever looked at request.signal. It is now a single timer cleared when
// the lifecycle settles, and the combined signal is built the first time
// something reads it. These tests pin that nothing a handler can observe moved.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("request timeout: one timer", () => {
  it("holds exactly one timer while a handler is pending, and none once it has answered", async () => {
    vi.useFakeTimers();
    const app = createApp({ requestTimeout: 1000 });
    let release: (() => void) | undefined;
    app.get("/pending", async (_req, reply) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return reply.json({ ok: true });
    });

    const before = vi.getTimerCount();
    const pending = app.handle(new Request("http://localhost/pending"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount() - before).toBe(1);

    release?.();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(vi.getTimerCount() - before).toBe(0);
  });

  it("clears the timer when the handler throws", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ requestTimeout: 1000 });
    app.get("/boom", async () => {
      await Promise.resolve();
      throw new Error("boom");
    });

    const before = vi.getTimerCount();
    const response = await app.handle(new Request("http://localhost/boom"));
    expect(response.status).toBe(500);
    expect(vi.getTimerCount() - before).toBe(0);
  });

  it("sets no timer at all with requestTimeout: 0", async () => {
    vi.useFakeTimers();
    const app = createApp({ requestTimeout: 0 });
    let release: (() => void) | undefined;
    app.get("/pending", async (_req, reply) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return reply.json({ ok: true });
    });

    const before = vi.getTimerCount();
    const pending = app.handle(new Request("http://localhost/pending"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount() - before).toBe(0);
    release?.();
    expect((await pending).status).toBe(200);
  });

  it("answers 504 at the timeout and drops the handler's late result", async () => {
    vi.useFakeTimers();
    const app = createApp({ requestTimeout: 100 });
    let finished = false;
    app.get("/slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      finished = true;
      return { late: true };
    });

    const pending = app.handle(new Request("http://localhost/slow"));
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ statusCode: 504, error: "Gateway Timeout" });

    await vi.advanceTimersByTimeAsync(500);
    expect(finished).toBe(true);
  });

  it("does not report a rejection from a handler that fails after the timeout", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const app = createApp({ requestTimeout: 10 });
      app.get("/late-failure", async () => {
        await sleep(40);
        throw new Error("too late to matter");
      });
      const response = await app.handle(new Request("http://localhost/late-failure"));
      expect(response.status).toBe(504);
      await sleep(80);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// The timer is only set when the lifecycle first goes asynchronous, but the
// deadline is the one a timer set at the start of the request would have had.
describe("request timeout: counted from the start of the request", () => {
  /** Keep the thread busy, as a handler doing synchronous work does. */
  const block = (ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end);
  };

  it("counts synchronous work in the handler before its first await", async () => {
    const app = createApp({ requestTimeout: 400 });
    let finished = false;
    app.get("/work", async () => {
      block(300);
      await sleep(250);
      finished = true;
      return { done: true };
    });

    const started = performance.now();
    const response = await app.handle(new Request("http://localhost/work"));
    const took = performance.now() - started;

    // 300 ms of work and a 250 ms wait under a 400 ms timeout: out of time
    // during the wait, about 400 ms in, not 550 ms in with a 200. (No upper
    // bound on the time: a busy machine may run the timer late, never early.)
    expect(response.status).toBe(504);
    expect(finished).toBe(false);
    expect(took).toBeGreaterThanOrEqual(395);
  });

  it("counts synchronous work in hooks that ran before an asynchronous handler", async () => {
    const app = createApp({ requestTimeout: 300 });
    app.addHook("onRequest", () => block(120));
    app.addHook("preHandler", () => block(120));
    app.get("/work", async () => {
      await sleep(200);
      return { done: true };
    });

    const response = await app.handle(new Request("http://localhost/work"));
    expect(response.status).toBe(504);
  });

  it("answers normally when the work and the wait together fit inside the timeout", async () => {
    const app = createApp({ requestTimeout: 2000 });
    app.get("/work", async () => {
      block(100);
      await sleep(50);
      return { done: true };
    });

    const response = await app.handle(new Request("http://localhost/work"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ done: true });
  });

  it("still answers when synchronous work overran the timeout but nothing is waited on afterwards", async () => {
    // A timer cannot interrupt synchronous work. One set at the start of the
    // request would be overdue here, and the answer, which needs no further
    // turn of the event loop, would still arrive before it fired.
    const app = createApp({ requestTimeout: 50 });
    app.get("/work", async () => {
      block(120);
      await Promise.resolve();
      return { done: true };
    });

    const response = await app.handle(new Request("http://localhost/work"));
    expect(response.status).toBe(200);
  });

  it("times out a wait that starts after the deadline has already passed", async () => {
    const app = createApp({ requestTimeout: 50 });
    let finished = false;
    app.get("/work", async () => {
      block(120);
      await sleep(100);
      finished = true;
      return { done: true };
    });

    const response = await app.handle(new Request("http://localhost/work"));
    expect(response.status).toBe(504);
    expect(finished).toBe(false);
  });

  it("gives a request that went asynchronous at once the configured duration exactly", async () => {
    vi.useFakeTimers();
    const app = createApp({ requestTimeout: 1000 });
    app.get("/pending", async () => {
      await new Promise(() => {});
    });

    const spy = vi.spyOn(globalThis, "setTimeout");
    const pending = app.handle(new Request("http://localhost/pending"));
    await vi.advanceTimersByTimeAsync(0);
    // The duration itself, not 999.97: Node keeps timers of one duration in one list.
    expect(spy.mock.calls.map((call) => call[1])).toEqual([1000]);

    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(504);
  });
});

describe("request.signal is built when it is read", () => {
  it("aborts a signal the handler is listening on, before the 504 is returned", async () => {
    const app = createApp({ requestTimeout: 20 });
    const order: string[] = [];
    app.get("/slow", async (req) => {
      req.signal.addEventListener("abort", () =>
        order.push(`abort:${(req.signal.reason as { statusCode?: number }).statusCode}`),
      );
      await sleep(200);
      return { late: true };
    });

    const response = await app.handle(new Request("http://localhost/slow"));
    order.push(`response:${response.status}`);
    expect(order).toEqual(["abort:504", "response:504"]);
  });

  it("reports the timeout on a signal first read after it fired", async () => {
    const app = createApp({ requestTimeout: 10 });
    let lateSignal: AbortSignal | undefined;
    let done: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    app.get("/slow", async (req) => {
      await sleep(60);
      lateSignal = req.signal;
      done?.();
      return { late: true };
    });

    const response = await app.handle(new Request("http://localhost/slow"));
    expect(response.status).toBe(504);
    await finished;
    expect(lateSignal?.aborted).toBe(true);
    expect(lateSignal?.reason).toMatchObject({ statusCode: 504 });
  });

  it("reports the transport's abort when it came before the timeout, even if read afterwards", async () => {
    const app = createApp({ requestTimeout: 30 });
    const transport = new AbortController();
    let lateSignal: AbortSignal | undefined;
    let done: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    app.get("/slow", async (req) => {
      await sleep(80);
      lateSignal = req.signal;
      done?.();
      return { late: true };
    });

    const pending = app.handle(new Request("http://localhost/slow", { signal: transport.signal }));
    transport.abort("client went away");
    expect((await pending).status).toBe(504);
    await finished;
    expect(lateSignal?.aborted).toBe(true);
    expect(lateSignal?.reason).toBe("client went away");
  });

  it("never aborts a signal for a request that finished in time", async () => {
    const app = createApp({ requestTimeout: 20 });
    let during: AbortSignal | undefined;
    let after: AbortSignal | undefined;
    let request: { signal: AbortSignal } | undefined;
    app.get("/fast", (req, reply) => {
      during = req.signal;
      request = req;
      return reply.json({ ok: true });
    });

    const response = await app.handle(new Request("http://localhost/fast"));
    expect(response.status).toBe(200);
    after = request?.signal;
    await sleep(60);
    expect(during?.aborted).toBe(false);
    expect(after?.aborted).toBe(false);
    // The same signal every time it is read.
    expect(after).toBe(during);
    expect(request?.signal).toBe(during);
  });

  it("follows the transport from a signal first read after the handler returned", async () => {
    const app = createApp();
    const transport = new AbortController();
    let request: { signal: AbortSignal } | undefined;
    app.get("/stream", (req) => {
      request = req;
      return new Response(new ReadableStream());
    });

    const response = await app.handle(new Request("http://localhost/stream", { signal: transport.signal }));
    const signal = request?.signal;
    expect(signal?.aborted).toBe(false);
    transport.abort("closed");
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("closed");
    await response.body?.cancel();
  });

  it.each([0, 1000])("is the same kind of value as before with requestTimeout: %i", async (requestTimeout) => {
    const app = createApp({ requestTimeout });
    let seen: Record<string, unknown> | undefined;
    app.get("/x", (req, reply) => {
      const { signal } = req;
      const replacement = new AbortController().signal;
      seen = { isSignal: signal instanceof AbortSignal, inRequest: "signal" in req, aborted: signal.aborted };
      // Still assignable, as the own property was.
      (req as { signal: AbortSignal }).signal = replacement;
      seen.replaced = req.signal === replacement;
      return reply.json({ ok: true });
    });

    await app.handle(new Request("http://localhost/x"));
    expect(seen).toEqual({ isSignal: true, inRequest: true, aborted: false, replaced: true });
  });
});
