// @celsian/core -- the request timeout is one timer, and request.signal is built on demand
//
// The timeout used to cost every request a Promise.race, a second promise, a
// .finally(), an AbortController and an AbortSignal.any(), whether or not the
// handler ever looked at request.signal. It is now a single timer cleared when
// the lifecycle settles, and the combined signal is built the first time
// something reads it. These tests pin that nothing a handler can observe moved.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { serve } from "../src/serve.js";

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

  it("sets no timer for a request that is answered synchronously, whatever answers it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ requestTimeout: 1000 });
    app.get("/sync", (_req, reply) => reply.json({ ok: true }));
    app.get("/value", () => ({ ok: true }));
    app.get("/throws", () => {
      throw new Error("boom");
    });
    app.get("/hooked", { onRequest: (_req, reply) => reply.status(403).json({ no: true }) }, () => ({ ok: true }));

    const set = vi.spyOn(globalThis, "setTimeout");
    for (const [path, status] of [
      ["/sync", 200],
      ["/value", 200],
      ["/throws", 500],
      ["/hooked", 403],
      ["/missing", 404],
    ] as const) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.status, path).toBe(status);
    }
    expect(set).not.toHaveBeenCalled();
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

// The callback that watches the lifecycle also finishes the response, and the
// timer's callback answers the 504 itself. Whatever the error path does next,
// synchronously or not, has to come out of the same promise.
describe("request timeout: what answers after it fires or after the lifecycle settles", () => {
  it("waits for an asynchronous error handler and asynchronous onSend hooks after a timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ requestTimeout: 30 });
    const order: string[] = [];
    app.setErrorHandler(async (error) => {
      await sleep(10);
      order.push("errorHandler");
      return new Response(`handled ${(error as { statusCode?: number }).statusCode}`, { status: 599 });
    });
    app.addHook("onSend", async (_request, reply) => {
      await sleep(10);
      order.push("onSend");
      reply.header("x-sent", "1");
    });
    app.addHook("onResponse", () => {
      order.push("onResponse");
    });
    app.get("/never", async () => {
      await new Promise(() => {});
    });

    const response = await app.handle(new Request("http://localhost/never"));
    expect(response.status).toBe(599);
    expect(await response.text()).toBe("handled 504");
    expect(response.headers.get("x-sent")).toBe("1");
    expect(order).toEqual(["errorHandler", "onSend", "onResponse"]);
  });

  it("answers a rejection through the error path, and a later timeout changes nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const app = createApp({ requestTimeout: 1000 });
    let onResponse = 0;
    app.addHook("onResponse", () => {
      onResponse++;
    });
    app.get("/rejects", async () => {
      await Promise.resolve();
      throw new Error("nope");
    });

    const before = vi.getTimerCount();
    const response = await app.handle(new Request("http://localhost/rejects"));
    expect(response.status).toBe(500);
    expect(vi.getTimerCount() - before).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onResponse).toBe(1);
  });

  it("runs onResponse once and answers HEAD without a body when an asynchronous handler finishes in time", async () => {
    const app = createApp({ requestTimeout: 1000 });
    let onResponse = 0;
    app.addHook("onResponse", () => {
      onResponse++;
    });
    app.get("/thing", async (_request, reply) => {
      await sleep(5);
      return reply.header("x-thing", "1").json({ thing: true });
    });

    const get = await app.handle(new Request("http://localhost/thing"));
    expect(await get.json()).toEqual({ thing: true });
    const head = await app.handle(new Request("http://localhost/thing", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("x-thing")).toBe("1");
    expect(await head.text()).toBe("");
    await sleep(5);
    expect(onResponse).toBe(2);
  });

  it("rejects handle() when the error path itself throws, in time or after a timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const requestTimeout of [20, 1000]) {
      const app = createApp({ requestTimeout });
      // A header name no response can carry: merging it throws while the 500 or 504 is being built.
      app.addHook("onSend", (_request, reply) => {
        reply.headers["bad name"] = "x";
      });
      app.get("/x", async () => {
        if (requestTimeout === 20) await new Promise(() => {});
        await Promise.resolve();
        throw new Error("boom");
      });

      await expect(app.handle(new Request("http://localhost/x"))).rejects.toBeInstanceOf(TypeError);
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

  // The deadline has passed by the time the lifecycle first waits, and the
  // handler set its own timer before that. A timer for the request timeout set
  // only now would be due after the handler's and lose to it; one set at the
  // start of the request, as on ef8953c, would already be due and win. None of
  // this depends on how busy the machine is: the work takes at least 60 ms
  // whatever the load, so the 25 ms deadline has always passed, and the order
  // of what runs next is fixed.
  it("answers 504 when the deadline passed before the first wait, though the handler set its own timer first", async () => {
    const app = createApp({ requestTimeout: 25 });
    const resumed: string[] = [];
    app.get("/work", async (req) => {
      block(60);
      await sleep(1);
      // The timeout came first, so the handler resumes with its signal aborted.
      resumed.push(`${req.signal.aborted}:${(req.signal.reason as { statusCode?: number } | undefined)?.statusCode}`);
      return "ok";
    });

    for (let i = 0; i < 4; i++) {
      const response = await app.handle(new Request("http://localhost/work"));
      expect(response.status, `request ${i}`).toBe(504);
    }
    await sleep(5);
    expect(resumed).toEqual(["true:504", "true:504", "true:504", "true:504"]);
  });

  it("answers 504 when hooks used up the time before an asynchronous handler set its timer", async () => {
    const app = createApp({ requestTimeout: 25 });
    app.addHook("onRequest", () => block(60));
    app.get("/work", async () => {
      await sleep(1);
      return "ok";
    });

    expect((await app.handle(new Request("http://localhost/work"))).status).toBe(504);
  });

  it("answers 504 over a real socket when the deadline passed before the first wait", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ requestTimeout: 25 });
    app.get("/work", async () => {
      block(60);
      await sleep(1);
      return "ok";
    });
    let port = 0;
    const server = await serve(app, {
      port: 0,
      host: "127.0.0.1",
      handleFatalErrors: false,
      shutdownTimeout: 200,
      onReady: (info) => {
        port = info.port;
      },
    });
    try {
      for (let i = 0; i < 3; i++) {
        const response = await fetch(`http://127.0.0.1:${port}/work`);
        expect(response.status, `request ${i}`).toBe(504);
        await response.arrayBuffer();
      }
    } finally {
      await server.close();
    }
  });

  it("still answers when the work overran and the rest is a long chain of microtasks", async () => {
    // Past the deadline, the 504 waits for the microtask queue to drain, so a
    // lifecycle that never waits on a timer or on I/O answers first, however
    // many steps it takes.
    const app = createApp({ requestTimeout: 25 });
    app.addHook("preHandler", async () => {
      await Promise.resolve();
    });
    app.addHook("onSend", async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    app.get("/work", async () => {
      block(60);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      return { done: true };
    });

    const response = await app.handle(new Request("http://localhost/work"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ done: true });
  });

  it("sets no timer when the deadline has already passed at the first wait", async () => {
    const app = createApp({ requestTimeout: 25 });
    app.get("/work", async () => {
      block(60);
      await new Promise(() => {});
    });
    const set = vi.spyOn(globalThis, "setTimeout");
    const response = await app.handle(new Request("http://localhost/work"));
    expect(response.status).toBe(504);
    expect(set).not.toHaveBeenCalled();
  });

  it("rounds what is left of the timeout up, so the timer never fires before the deadline", async () => {
    vi.useFakeTimers();
    let now = 5000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const app = createApp({ requestTimeout: 1000 });
    app.get("/pending", async () => {
      // 1.5 ms of synchronous work before the first wait: 998.5 ms are left.
      now += 1.5;
      await new Promise(() => {});
    });

    const spy = vi.spyOn(globalThis, "setTimeout");
    const pending = app.handle(new Request("http://localhost/pending"));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(spy.mock.calls.map((call) => call[1])).toEqual([999]);

    // 998.5 ms after the start of the request, the request still has time.
    await vi.advanceTimersByTimeAsync(998);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(504);
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
