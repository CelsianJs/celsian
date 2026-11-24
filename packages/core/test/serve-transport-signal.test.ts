// @celsian/core -- request.signal over a real socket follows the client connection
//
// core's Node server used to build the transport signal for every request and
// hand it to `new Request()`, which built a second controller to follow the
// first. It now builds the signal the first time something reads it. These
// cases pin what a handler can see of it, and each one also holds on the
// server as it was before.

import { Agent, request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CelsianApp, createApp } from "../src/app.js";
import { type ServeResult, serve } from "../src/serve.js";

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise and the function that resolves it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe.each([0, 30_000])("request.signal on core's Node server, requestTimeout %i", (requestTimeout) => {
  it("is an unaborted AbortSignal for an ordinary request, and stays one", async () => {
    const app = createApp({ requestTimeout });
    const seen: AbortSignal[] = [];
    app.get("/x", (req, reply) => {
      const first = req.signal;
      const second = req.signal;
      seen.push(first);
      return reply.json({ aborted: first.aborted, same: first === second });
    });
    const port = await listen(app);

    const res = await fetch(`http://127.0.0.1:${port}/x`);
    expect(await res.json()).toEqual({ aborted: false, same: true });
    await sleep(30);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.aborted).toBe(false);
  });

  it("aborts a signal the handler holds when the client disconnects", async () => {
    const app = createApp({ requestTimeout });
    const entered = gate();
    const release = gate();
    let signal: AbortSignal | undefined;
    let abortEvents = 0;
    app.get("/pending", async (req) => {
      signal = req.signal;
      signal.addEventListener("abort", () => abortEvents++);
      entered.open();
      await release.opened;
      return new Response("done");
    });
    const port = await listen(app);

    const client = httpRequest(`http://127.0.0.1:${port}/pending`);
    client.on("error", () => {});
    client.end();
    try {
      await entered.opened;
      expect(signal?.aborted).toBe(false);
      client.destroy();
      await expect.poll(() => signal?.aborted, { timeout: 1000 }).toBe(true);
      expect(abortEvents).toBe(1);
    } finally {
      release.open();
      client.destroy();
    }
  });

  it("reports a disconnect that happened before the handler first read the signal", async () => {
    const app = createApp({ requestTimeout });
    const entered = gate();
    const disconnected = gate();
    const finished = gate();
    let aborted: boolean | undefined;
    app.get("/pending", async (req) => {
      entered.open();
      await disconnected.opened;
      // First read, after the client has already gone.
      aborted = req.signal.aborted;
      finished.open();
      return new Response("done");
    });
    const port = await listen(app);

    const client = httpRequest(`http://127.0.0.1:${port}/pending`);
    client.on("error", () => {});
    client.end();
    await entered.opened;
    client.destroy();
    await sleep(50);
    disconnected.open();
    await finished.opened;
    expect(aborted).toBe(true);
  });

  it("also aborts the signal of a clone", async () => {
    const app = createApp({ requestTimeout });
    const entered = gate();
    const release = gate();
    let cloned: AbortSignal | undefined;
    app.post("/pending", async (req) => {
      cloned = req.clone().signal;
      entered.open();
      await release.opened;
      return new Response("done");
    });
    const port = await listen(app);

    const client = httpRequest(`http://127.0.0.1:${port}/pending`, { method: "POST" });
    client.on("error", () => {});
    client.end("payload");
    try {
      await entered.opened;
      expect(cloned?.aborted).toBe(false);
      client.destroy();
      await expect.poll(() => cloned?.aborted, { timeout: 1000 }).toBe(true);
    } finally {
      release.open();
      client.destroy();
    }
  });

  // A Request made from another Request follows the signal the source holds
  // internally, which is not the one its `signal` property reports. A lazily
  // built Request holds one that never aborts, so the two places a Request
  // leaves core (a replaced `app.handle`, and `clone()`) get a real one.
  it.each([
    [
      "replaced on the instance",
      (app: CelsianApp) => {
        const handle = app.handle.bind(app);
        app.handle = (request) => handle(new Request(request, { headers: new Headers(request.headers) }));
      },
    ],
    [
      "wrapped without rebuilding the request",
      (app: CelsianApp) => {
        const handle = app.handle.bind(app);
        app.handle = (request) => handle(request);
      },
    ],
  ])("aborts the signal of a request that went through an app.handle %s", async (_label, wrap) => {
    const app = createApp({ requestTimeout });
    const entered = gate();
    const release = gate();
    let signal: AbortSignal | undefined;
    let abortEvents = 0;
    app.post("/pending", async (req) => {
      signal = req.signal;
      signal.addEventListener("abort", () => abortEvents++, { once: true });
      entered.open();
      await release.opened;
      return { body: req.parsedBody };
    });
    wrap(app);
    const port = await listen(app);

    const client = httpRequest(`http://127.0.0.1:${port}/pending`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    client.on("error", () => {});
    client.end('{"n":1}');
    try {
      await entered.opened;
      expect(signal?.aborted).toBe(false);
      client.destroy();
      await expect.poll(() => signal?.aborted, { timeout: 1000 }).toBe(true);
      expect(abortEvents).toBe(1);
    } finally {
      release.open();
      client.destroy();
    }
  });

  it("aborts the signal of a request that an overriding subclass rebuilt", async () => {
    class Rebuilding extends CelsianApp {
      override handle(request: Request): Promise<Response> {
        return super.handle(new Request(request, { headers: new Headers(request.headers) }));
      }
    }
    const app = new Rebuilding({ requestTimeout });
    const entered = gate();
    const release = gate();
    let signal: AbortSignal | undefined;
    app.get("/pending", async (req) => {
      signal = req.signal;
      entered.open();
      await release.opened;
      return new Response("done");
    });
    const port = await listen(app);

    const client = httpRequest(`http://127.0.0.1:${port}/pending`);
    client.on("error", () => {});
    client.end();
    try {
      await entered.opened;
      expect(signal?.aborted).toBe(false);
      client.destroy();
      await expect.poll(() => signal?.aborted, { timeout: 1000 }).toBe(true);
    } finally {
      release.open();
      client.destroy();
    }
  });

  it("still parses the body of a request that a replaced app.handle rebuilt", async () => {
    const app = createApp({ requestTimeout });
    app.post("/echo", (req) => ({ body: req.parsedBody, marked: req.headers.get("x-wrapped") }));
    const handle = app.handle.bind(app);
    app.handle = (request) => {
      const headers = new Headers(request.headers);
      headers.set("x-wrapped", "1");
      return handle(new Request(request, { headers }));
    };
    const port = await listen(app);

    const res = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", n: [1, 2, 3] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: { name: "Ada", n: [1, 2, 3] }, marked: "1" });
  });

  it("aborts the signal of a Request built from a clone, and of a clone of a clone", async () => {
    const app = createApp({ requestTimeout });
    const entered = gate();
    const release = gate();
    let rebuilt: AbortSignal | undefined;
    let twice: AbortSignal | undefined;
    let cloneBody: string | undefined;
    app.post("/pending", async (req) => {
      const clone = req.clone();
      twice = clone.clone().signal;
      // What `fetch(clone)` and any proxying code does with it.
      const upstream = new Request(clone, { headers: { "x-forwarded": "1" } });
      rebuilt = upstream.signal;
      cloneBody = await upstream.text();
      entered.open();
      await release.opened;
      return new Response("done");
    });
    const port = await listen(app);

    // A content type nothing parses, so the body is still there to clone.
    const client = httpRequest(`http://127.0.0.1:${port}/pending`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
    });
    client.on("error", () => {});
    client.end("payload");
    try {
      await entered.opened;
      expect(cloneBody).toBe("payload");
      expect(rebuilt?.aborted).toBe(false);
      expect(twice?.aborted).toBe(false);
      client.destroy();
      await expect.poll(() => rebuilt?.aborted, { timeout: 1000 }).toBe(true);
      await expect.poll(() => twice?.aborted, { timeout: 1000 }).toBe(true);
    } finally {
      release.open();
      client.destroy();
    }
  });

  it("gives a clone the method, URL, headers and body of the request", async () => {
    const app = createApp({ requestTimeout });
    app.post("/clone", async (req) => {
      const clone = req.clone();
      return {
        isRequest: clone instanceof Request,
        method: clone.method,
        path: new URL(clone.url).pathname + new URL(clone.url).search,
        header: clone.headers.get("x-thing"),
        usedBefore: clone.bodyUsed,
        text: await clone.text(),
        usedAfter: clone.bodyUsed,
        original: await req.text(),
      };
    });
    const port = await listen(app);

    const res = await fetch(`http://127.0.0.1:${port}/clone?a=1`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-thing": "yes" },
      body: "h\u00e9llo",
    });
    expect(await res.json()).toEqual({
      isRequest: true,
      method: "POST",
      path: "/clone?a=1",
      header: "yes",
      usedBefore: false,
      text: "h\u00e9llo",
      usedAfter: true,
      original: "h\u00e9llo",
    });
  });

  it("does not abort after the response, whether the signal was read during the request or only afterwards", async () => {
    const app = createApp({ requestTimeout });
    let during: AbortSignal | undefined;
    let request: { signal: AbortSignal } | undefined;
    app.get("/read", (req, reply) => {
      during = req.signal;
      return reply.json({ ok: true });
    });
    app.get("/unread", (req, reply) => {
      request = req;
      return reply.json({ ok: true });
    });
    const port = await listen(app);

    // `connection: close`, so the socket really closes right after each response.
    for (const path of ["/read", "/unread"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { connection: "close" } });
      expect(await res.json()).toEqual({ ok: true });
    }
    await sleep(50);
    const after = request?.signal;
    await sleep(20);

    expect(during?.aborted).toBe(false);
    expect(after).toBeInstanceOf(AbortSignal);
    expect(after?.aborted).toBe(false);
  });

  // The other side of the test above. A request the client abandoned, whose
  // signal nobody read while it was in flight, must still say so afterwards.
  it("reports the abort on a signal first read after the request ended, when the client had gone by then", async () => {
    const app = createApp({ requestTimeout });
    const entered = gate();
    const release = gate();
    const finished = gate();
    let request: { signal: AbortSignal } | undefined;
    app.addHook("onResponse", () => {
      finished.open();
    });
    app.get("/pending", async (req) => {
      // Held, but its signal is not read.
      request = req;
      entered.open();
      await release.opened;
      return new Response("done");
    });
    app.get("/completed", (req, reply) => {
      request = req;
      return reply.json({ ok: true });
    });
    const port = await listen(app);

    const client = httpRequest(`http://127.0.0.1:${port}/pending`);
    client.on("error", () => {});
    client.end();
    await entered.opened;
    client.destroy();
    // Let the server see the hang-up before the handler answers.
    await sleep(50);
    release.open();
    await finished.opened;
    await sleep(20);

    const late = request?.signal;
    expect(late).toBeInstanceOf(AbortSignal);
    expect(late?.aborted).toBe(true);
    // The same signal on every later read.
    expect(request?.signal).toBe(late);

    // And a request that completed normally, on a connection that then stayed
    // open, reports no abort, however late it is asked.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({ port, host: "127.0.0.1", path: "/completed", agent }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", reject);
        req.end();
      });
      await sleep(30);
      const kept = request?.signal;
      expect(kept).not.toBe(late);
      expect(kept?.aborted).toBe(false);
    } finally {
      agent.destroy();
    }
  });

  it("leaves no listener behind on a keep-alive socket", async () => {
    const app = createApp({ requestTimeout });
    app.get("/read", (req, reply) => reply.json({ aborted: req.signal.aborted }));
    const port = await listen(app);

    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const get = () =>
      new Promise<number | undefined>((resolve, reject) => {
        let localPort: number | undefined;
        const req = httpRequest({ port, host: "127.0.0.1", path: "/read", agent }, (res) => {
          res.resume();
          res.on("end", () => resolve(localPort));
        });
        req.on("socket", (socket) => {
          const record = () => {
            localPort = socket.localPort;
          };
          if (socket.connecting) socket.once("connect", record);
          else record();
        });
        req.on("error", reject);
        req.end();
      });
    try {
      // Twenty requests, each reading the signal, all over one socket. Had each
      // left its 'close' listener on that socket, Node would warn at the eleventh.
      const ports = new Set<number | undefined>();
      for (let i = 0; i < 20; i++) ports.add(await get());
      await sleep(30);
      expect(ports.size).toBe(1);
      expect(warnings.filter((warning) => warning.name === "MaxListenersExceededWarning")).toEqual([]);
    } finally {
      process.off("warning", onWarning);
      agent.destroy();
    }
  });
});

// request.signal follows the transport with a listener on the transport's
// signal. That listener is added after any the application put there first,
// and an ordinary listener does not run when an earlier one calls
// `event.stopImmediatePropagation()`. With AbortSignal.any(), as on ef8953c,
// nothing an application listener did could keep the abort from arriving, and
// it still cannot.
describe.each([0, 30_000])(
  "request.signal after another listener stopped the transport's abort event, requestTimeout %i",
  (requestTimeout) => {
    /** A listener that keeps every later listener on the same signal from running. */
    const stopper = (event: Event) => event.stopImmediatePropagation();

    it("aborts with the transport's reason when the abort comes during the handler", async () => {
      const transport = new AbortController();
      const input = new Request("http://localhost/x", { signal: transport.signal });
      input.signal.addEventListener("abort", stopper);
      const app = createApp({ requestTimeout });
      const heard: unknown[] = [];
      app.get("/x", (req, reply) => {
        const { signal } = req;
        signal.addEventListener("abort", () => heard.push(signal.reason));
        transport.abort("cancelled");
        return reply.json({ aborted: signal.aborted, reason: signal.reason });
      });

      const res = await app.handle(input);
      expect(await res.json()).toEqual({ aborted: true, reason: "cancelled" });
      // With no timeout, request.signal is the transport's signal itself, and
      // a listener put on it before the handler's stops the handler's, as on
      // any signal. With one, it is a signal of its own and hears the abort.
      expect(heard).toEqual(requestTimeout > 0 ? ["cancelled"] : []);
    });

    it("aborts when the abort comes while an asynchronous handler waits", async () => {
      const transport = new AbortController();
      const input = new Request("http://localhost/x", { signal: transport.signal });
      input.signal.addEventListener("abort", stopper);
      const app = createApp({ requestTimeout });
      const entered = gate();
      const release = gate();
      let signal: AbortSignal | undefined;
      app.get("/x", async (req, reply) => {
        signal = req.signal;
        entered.open();
        await release.opened;
        return reply.json({ reason: signal.reason });
      });

      const pending = app.handle(input);
      await entered.opened;
      transport.abort("gone");
      expect(signal?.aborted).toBe(true);
      release.open();
      expect(await (await pending).json()).toEqual({ reason: "gone" });
    });

    it("aborts over a real socket when a replaced app.handle stopped the event on the transport's signal", async () => {
      const app = createApp({ requestTimeout });
      const entered = gate();
      const release = gate();
      let signal: AbortSignal | undefined;
      app.get("/pending", async (req) => {
        signal = req.signal;
        entered.open();
        await release.opened;
        return new Response("done");
      });
      const handle = app.handle.bind(app);
      app.handle = (request: Request) => {
        request.signal.addEventListener("abort", stopper);
        return handle(request);
      };
      const port = await listen(app);

      const client = httpRequest(`http://127.0.0.1:${port}/pending`);
      client.on("error", () => {});
      client.end();
      try {
        await entered.opened;
        expect(signal?.aborted).toBe(false);
        client.destroy();
        await expect.poll(() => signal?.aborted, { timeout: 1000 }).toBe(true);
      } finally {
        release.open();
        client.destroy();
      }
    });
  },
);

// Deno has an events.addAbortListener, but it is an ordinary listener, which a
// stopped event blocks. core tries the one it finds when it loads and, off
// Node, falls back to AbortSignal.any() when it does not hold, as before.
describe("request.signal on a runtime whose addAbortListener can be stopped", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("still aborts after an earlier listener stopped the transport's abort event", async () => {
    const proc = process as unknown as { getBuiltinModule: (id: string) => unknown };
    const real = proc.getBuiltinModule;
    const ordinary = (signal: AbortSignal, listener: () => void) =>
      signal.addEventListener("abort", listener, { once: true });
    vi.stubGlobal("navigator", { userAgent: "Deno/2.9.8" });
    proc.getBuiltinModule = (id: string) => (id === "node:events" ? { addAbortListener: ordinary } : real(id));
    vi.resetModules();
    try {
      const { createApp: createAppOffNode } = await import("../src/app.js");
      const transport = new AbortController();
      const input = new Request("http://localhost/x", { signal: transport.signal });
      input.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
      const app = createAppOffNode({ requestTimeout: 30_000 });
      app.get("/x", (req, reply) => {
        const { signal } = req;
        transport.abort("cancelled");
        return reply.json({ aborted: signal.aborted, reason: signal.reason });
      });

      const res = await app.handle(input);
      expect(await res.json()).toEqual({ aborted: true, reason: "cancelled" });
    } finally {
      proc.getBuiltinModule = real;
    }
  });
});

describe("a global Request replaced after core loaded", () => {
  it("is still what requests are built with, signal included", async () => {
    const app = createApp();
    const entered = gate();
    const release = gate();
    let signal: AbortSignal | undefined;
    app.get("/pending", async (req) => {
      signal = req.signal;
      entered.open();
      await release.opened;
      return new Response("done");
    });
    const port = await listen(app);

    const Original = globalThis.Request;
    let built = 0;
    let builtWithSignal = 0;
    const Replaced: typeof Request = new Proxy(Original, {
      construct(target, args, newTarget) {
        built++;
        if ((args[1] as RequestInit | undefined)?.signal instanceof AbortSignal) builtWithSignal++;
        return Reflect.construct(target, args, newTarget === Replaced ? target : newTarget);
      },
    });
    globalThis.Request = Replaced;
    const client = httpRequest(`http://127.0.0.1:${port}/pending`);
    client.on("error", () => {});
    client.end();
    try {
      await entered.opened;
      expect(built).toBe(1);
      expect(builtWithSignal).toBe(1);
      client.destroy();
      await expect.poll(() => signal?.aborted, { timeout: 1000 }).toBe(true);
    } finally {
      globalThis.Request = Original;
      release.open();
      client.destroy();
    }
  });
});
