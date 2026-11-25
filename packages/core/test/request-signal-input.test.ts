// @celsian/core -- how request.signal follows the signal of the Request the app is handed
//
// With a request timeout (the default) `request.signal` is a signal of its own,
// which the timeout can abort without aborting the input. It follows the input
// Request's signal: core's Node server's connection signal, an adapter's, or
// whatever a caller of app.handle() passed. These cases pin how: that it hears
// the input's abort whatever the input's other listeners do, and that an
// input signal is never what keeps a finished request alive.

import { getEventListeners } from "node:events";
import { connect } from "node:net";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { type ServeResult, serve } from "../src/serve.js";

v8.setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Collect until none of `refs` is alive, or about three seconds have passed. Returns how many survived. */
async function survivors(refs: WeakRef<object>[]): Promise<number> {
  let alive = refs.length;
  for (let round = 0; round < 30 && alive > 0; round++) {
    // A WeakRef's target is kept until the current job ends, so yield first.
    await sleep(100);
    collectGarbage();
    alive = refs.filter((ref) => ref.deref() !== undefined).length;
  }
  return alive;
}

/** A few rounds of collection, with a turn of the event loop between them for finalizers. */
async function collect(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await sleep(20);
    collectGarbage();
  }
}

let server: ServeResult | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function listen(app: CelsianApp): Promise<number> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  let port = 0;
  server = await serve(app, {
    port: 0,
    host: "127.0.0.1",
    handleFatalErrors: false,
    shutdownTimeout: 200,
    onReady: (info) => {
      port = info.port;
    },
  });
  return port;
}

describe("request.signal, an input signal that many requests share", () => {
  it("leaves no listener on the input and keeps no finished request's signal alive", async () => {
    const source = new AbortController();
    const input = new Request("http://localhost/", { signal: source.signal });
    const seen: WeakRef<AbortSignal>[] = [];
    const app = createApp();
    app.get("/", (request) => {
      seen.push(new WeakRef(request.signal));
      return "ok";
    });

    for (let i = 0; i < 30; i++) expect((await app.handle(input)).status).toBe(200);
    expect(getEventListeners(input.signal, "abort")).toHaveLength(0);
    expect(await survivors(seen)).toBe(0);
    source.abort();
    expect(getEventListeners(input.signal, "abort")).toHaveLength(0);
  });

  it("still aborts, with the input's reason, a signal that something holds after its request finished", async () => {
    const source = new AbortController();
    const input = new Request("http://localhost/", { signal: source.signal });
    const held: AbortSignal[] = [];
    const app = createApp();
    app.get("/", (request) => {
      held.push(request.signal);
      return "ok";
    });

    for (let i = 0; i < 3; i++) await app.handle(input);
    await collect();
    expect(held.map((signal) => signal.aborted)).toEqual([false, false, false]);
    source.abort("shutting down");
    expect(held.map((signal) => signal.reason)).toEqual(["shutting down", "shutting down", "shutting down"]);
  });

  it("lets a signal that only has listeners go once nothing else holds it", async () => {
    const source = new AbortController();
    const input = new Request("http://localhost/", { signal: source.signal });
    const seen: WeakRef<AbortSignal>[] = [];
    let heard = 0;
    const app = createApp();
    app.get("/", (request) => {
      request.signal.addEventListener("abort", () => heard++);
      seen.push(new WeakRef(request.signal));
      return "ok";
    });

    await app.handle(input);
    await app.handle(input);
    expect(await survivors(seen)).toBe(0);
    source.abort();
    expect(heard).toBe(0);
  });
});

describe("request.signal, an input signal of its own", () => {
  it("keeps a listener on request.signal working after the handler returned, for as long as the input lives", async () => {
    const source = new AbortController();
    const heard: unknown[] = [];
    const app = createApp();
    app.get("/", (request) => {
      // Nothing but this listener refers to the signal once the handler returns.
      request.signal.addEventListener("abort", function onAbort(this: AbortSignal) {
        heard.push(this.reason);
      });
      return "ok";
    });

    // Held, as a runtime holds the Request it is answering until the answer is done.
    const input = new Request("http://localhost/", { signal: source.signal });
    await app.handle(input);
    await collect();
    source.abort("client went away");
    expect(input.signal.aborted).toBe(true);
    expect(heard).toEqual(["client went away"]);
  });

  it("over a real socket: a listener alone on request.signal hears the client go while a stream is sent", async () => {
    const app = createApp();
    const started: Array<() => void> = [];
    const heard: string[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    app.get("/events", (request) => {
      request.signal.addEventListener("abort", () => {
        clearInterval(timer);
        heard.push("aborted");
      });
      // The stream refers to neither the request nor its signal.
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("data: 1\n\n"));
            timer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode("data: x\n\n"));
              } catch {}
            }, 20);
            started.shift()?.();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const port = await listen(app);

    const streaming = new Promise<void>((resolve) => started.push(resolve));
    const socket = connect({ port, host: "127.0.0.1" }, () => socket.write("GET /events HTTP/1.1\r\nHost: x\r\n\r\n"));
    socket.on("data", () => {});
    socket.on("error", () => {});
    try {
      await streaming;
      await collect();
      socket.destroy();
      await expect.poll(() => heard, { timeout: 2000 }).toEqual(["aborted"]);
    } finally {
      clearInterval(timer);
      socket.destroy();
    }
  });
});

describe("request.signal, an earlier listener that stops the input's abort event", () => {
  const stopper = (event: Event) => event.stopImmediatePropagation();

  afterEach(() => {
    vi.resetModules();
  });

  it("aborts even where Node has no process.getBuiltinModule (Node 20 before 20.16)", async () => {
    const proc = process as unknown as { getBuiltinModule?: unknown };
    const real = proc.getBuiltinModule;
    delete proc.getBuiltinModule;
    vi.resetModules();
    try {
      const { createApp: createAppOnOldNode } = await import("../src/app.js");
      const source = new AbortController();
      const input = new Request("http://localhost/x", { signal: source.signal });
      input.signal.addEventListener("abort", stopper);
      const app = createAppOnOldNode();
      app.get("/x", (request, reply) => {
        const { signal } = request;
        source.abort("cancelled");
        return reply.json({ aborted: signal.aborted, reason: signal.reason });
      });
      expect(await (await app.handle(input)).json()).toEqual({ aborted: true, reason: "cancelled" });
    } finally {
      proc.getBuiltinModule = real;
    }
  });

  it("can be stopped where the runtime has no AbortSignal.any (Node 20.0 to 20.2)", async () => {
    const real = AbortSignal.any;
    (AbortSignal as { any?: unknown }).any = undefined;
    vi.resetModules();
    try {
      const { createApp: createAppWithoutAny } = await import("../src/app.js");
      const source = new AbortController();
      const input = new Request("http://localhost/x", { signal: source.signal });
      input.signal.addEventListener("abort", stopper);
      const app = createAppWithoutAny();
      app.get("/x", (request, reply) => {
        const { signal } = request;
        source.abort("cancelled");
        return reply.json({ aborted: signal.aborted });
      });
      expect(await (await app.handle(input)).json()).toEqual({ aborted: false });
    } finally {
      AbortSignal.any = real;
    }
  });
});

describe("request.signal stops following its input", () => {
  afterEach(() => {
    vi.resetModules();
  });

  /** Every signal AbortSignal.any() makes while `run` runs, with core loaded afresh to see them. */
  async function relaysMadeBy(run: (make: typeof createApp) => Promise<void>): Promise<AbortSignal[]> {
    const real = AbortSignal.any;
    const made: AbortSignal[] = [];
    AbortSignal.any = (signals: AbortSignal[]) => {
      const signal = real.call(AbortSignal, signals);
      made.push(signal);
      return signal;
    };
    try {
      vi.resetModules();
      await run((await import("../src/app.js")).createApp);
    } finally {
      AbortSignal.any = real;
    }
    return made;
  }

  it("as soon as the request timeout aborts it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = new AbortController();
    let status = 0;
    const relays = await relaysMadeBy(async (make) => {
      const app = make({ requestTimeout: 15 });
      app.get("/", (request) => {
        void request.signal;
        return new Promise<never>(() => {});
      });
      status = (await app.handle(new Request("http://localhost/", { signal: source.signal }))).status;
    });
    expect(status).toBe(504);
    expect(relays).toHaveLength(1);
    expect(getEventListeners(relays[0] as AbortSignal, "abort")).toHaveLength(0);
    expect(source.signal.aborted).toBe(false);
  });

  it("as soon as the input aborts", async () => {
    const source = new AbortController();
    let signal: AbortSignal | undefined;
    const relays = await relaysMadeBy(async (make) => {
      const app = make();
      app.get("/", (request) => {
        signal = request.signal;
        return "ok";
      });
      await app.handle(new Request("http://localhost/", { signal: source.signal }));
    });
    expect(getEventListeners(relays[0] as AbortSignal, "abort")).toHaveLength(1);
    source.abort("gone");
    expect(signal?.reason).toBe("gone");
    expect(getEventListeners(relays[0] as AbortSignal, "abort")).toHaveLength(0);
  });

  it("once the signal has been collected", async () => {
    const source = new AbortController();
    const input = new Request("http://localhost/", { signal: source.signal });
    const relays = await relaysMadeBy(async (make) => {
      const app = make();
      app.get("/", (request) => {
        void request.signal;
        return "ok";
      });
      // Twice, so that the input is shared and keeps neither request.
      await app.handle(input);
      await app.handle(input);
    });
    expect(relays).toHaveLength(2);
    for (let round = 0; round < 30; round++) {
      if (relays.every((relay) => getEventListeners(relay, "abort").length === 0)) break;
      await collect(1);
    }
    expect(relays.map((relay) => getEventListeners(relay, "abort").length)).toEqual([0, 0]);
  });

  it("without AbortSignal.any, as soon as the request timeout aborts it: no listener is left on the input", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const real = AbortSignal.any;
    (AbortSignal as { any?: unknown }).any = undefined;
    vi.resetModules();
    try {
      const { createApp: createAppWithoutAny } = await import("../src/app.js");
      const source = new AbortController();
      const input = new Request("http://localhost/", { signal: source.signal });
      const app = createAppWithoutAny({ requestTimeout: 15 });
      app.get("/", (request) => {
        void request.signal;
        return new Promise<never>(() => {});
      });
      expect((await app.handle(input)).status).toBe(504);
      expect(getEventListeners(input.signal, "abort")).toHaveLength(0);
    } finally {
      AbortSignal.any = real;
      vi.resetModules();
    }
  });
});
