// @celsian/core -- a listener left on request.signal must not keep the request alive
//
// `request.signal` used to be `AbortSignal.any([transport, timeout])` whenever a
// request timeout was set, which is the default. Node keeps a composite signal
// that has an "abort" listener in a process-wide set until the listener is
// removed, so a handler that did the ordinary thing,
//
//   request.signal.addEventListener("abort", stop);   // no { once: true }
//
// pinned that signal for the life of the process. When the client had gone
// away mid-request the signal's sources and its abort reason came with it: the
// IncomingMessage, the Socket and the ServerResponse, about 8 KB per abandoned
// request, never collected. A listener that closes over `request` pinned every
// request, completed or not.
//
// These tests force a collection and look at what is left.

import { IncomingMessage } from "node:http";
import { connect } from "node:net";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { type ServeResult, serve } from "../src/serve.js";
import type { CelsianRequest } from "../src/types.js";

v8.setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Live IncomingMessage objects, or undefined where Node cannot count them (before 20.13). */
function liveIncomingMessages(): number | undefined {
  const queryObjects = (v8 as { queryObjects?: (ctor: unknown, options: { format: "count" }) => number }).queryObjects;
  return typeof queryObjects === "function" ? queryObjects(IncomingMessage, { format: "count" }) : undefined;
}

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

const REQUESTS = 25;

/**
 * Send one request and hang up once `entered` has resolved (the handler is
 * running and has its listener on), or read the whole answer when it is omitted.
 */
function send(port: number, path: string, hangUpAfter?: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n${hangUpAfter ? "" : "Connection: close\r\n"}\r\n`);
      if (hangUpAfter) void hangUpAfter().then(() => socket.destroy());
    });
    socket.on("data", () => {});
    socket.on("close", () => resolve());
    socket.on("error", () => resolve());
  });
}

/** Resolves when `count()` reaches `target`, or after about two seconds. */
async function reached(count: () => number, target: number): Promise<void> {
  for (let i = 0; i < 200 && count() < target; i++) await sleep(10);
}

describe.each([
  ["the default request timeout", undefined],
  ["no request timeout", 0],
])("a listener left on request.signal, with %s", (_label, requestTimeout) => {
  const options = requestTimeout === undefined ? {} : { requestTimeout };

  it("does not keep a streaming request alive after the client hung up", async () => {
    const app = createApp(options);
    const signals: WeakRef<object>[] = [];
    let entered = 0;
    let aborted = 0;
    app.get("/events", (request) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        aborted++;
        clearInterval(timer);
      };
      // Not { once: true }, and never removed: what most handlers write.
      request.signal.addEventListener("abort", stop);
      signals.push(new WeakRef(request.signal));
      entered++;
      return new Response(
        new ReadableStream({
          start(controller) {
            timer = setInterval(() => controller.enqueue(new TextEncoder().encode("data: x\n\n")), 10);
          },
          cancel() {
            clearInterval(timer);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const port = await listen(app);
    const before = liveIncomingMessages();

    for (let i = 0; i < REQUESTS; i++) {
      await send(port, "/events", () => reached(() => entered, i + 1));
      await reached(() => aborted, i + 1);
    }
    expect(aborted).toBe(REQUESTS);

    expect(await survivors(signals)).toBe(0);
    const after = liveIncomingMessages();
    if (before !== undefined && after !== undefined) expect(after - before).toBeLessThanOrEqual(0);
  }, 30_000);

  it("does not keep a pending request alive after the client hung up", async () => {
    const app = createApp(options);
    const signals: WeakRef<object>[] = [];
    let entered = 0;
    let aborted = 0;
    app.get("/wait", async (request) => {
      let cancelled = false;
      // Stays pending until the hang-up has been seen, so the abort always
      // arrives while the request is in flight, however busy the machine is.
      await new Promise<void>((resolve) => {
        const giveUp = setTimeout(resolve, 5000);
        request.signal.addEventListener("abort", () => {
          cancelled = true;
          aborted++;
          clearTimeout(giveUp);
          resolve();
        });
        signals.push(new WeakRef(request.signal));
        entered++;
      });
      await sleep(20);
      return { cancelled };
    });
    const port = await listen(app);
    const before = liveIncomingMessages();

    for (let i = 0; i < REQUESTS; i++) {
      await send(port, "/wait", () => reached(() => entered, i + 1));
      await reached(() => aborted, i + 1);
    }
    expect(aborted).toBe(REQUESTS);
    // Let the abandoned handlers finish before looking.
    await sleep(100);

    expect(await survivors(signals)).toBe(0);
    const after = liveIncomingMessages();
    if (before !== undefined && after !== undefined) expect(after - before).toBeLessThanOrEqual(0);
  }, 30_000);

  it("does not keep a completed request alive when the listener closes over the request", async () => {
    const app = createApp(options);
    const requests: WeakRef<object>[] = [];
    app.get("/quick", (request: CelsianRequest) => {
      let cancelledAt = "";
      request.signal.addEventListener("abort", () => {
        cancelledAt = request.url;
      });
      requests.push(new WeakRef(request), new WeakRef(request.signal));
      return { cancelledAt };
    });
    const port = await listen(app);
    const before = liveIncomingMessages();

    for (let i = 0; i < REQUESTS; i++) await send(port, "/quick");
    expect(requests).toHaveLength(REQUESTS * 2);

    expect(await survivors(requests)).toBe(0);
    const after = liveIncomingMessages();
    if (before !== undefined && after !== undefined) expect(after - before).toBeLessThanOrEqual(0);
  }, 30_000);
});
