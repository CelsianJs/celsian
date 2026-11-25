// @celsian/core -- core's Node server goes through app.handle whenever it is not the stock method
//
// serve() calls an internal entry point instead of `app.handle` when nothing
// replaced it, which saves a promise and lets a fast response be written as
// is. Whoever did replace it, on the instance, in a subclass or on
// CelsianApp.prototype itself, must still be called, and whatever their
// handle returns must still be answered the way `await app.handle()` would
// answer it.

import { request as httpRequest } from "node:http";
import { runInNewContext } from "node:vm";
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

/** A promise and the function that resolves it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("a handle replaced on CelsianApp.prototype", () => {
  const original = CelsianApp.prototype.handle;
  afterEach(() => {
    CelsianApp.prototype.handle = original;
  });

  it("is called for every request, and its answer is the one sent", async () => {
    let calls = 0;
    CelsianApp.prototype.handle = async function (this: CelsianApp, request: Request) {
      calls++;
      const response = await original.call(this, new Request(request, { headers: request.headers }));
      const headers = new Headers(response.headers);
      headers.set("x-wrapped", "prototype");
      return new Response(response.body, { status: response.status, headers });
    };
    const app = createApp();
    app.get("/", () => "ok");
    const port = await listen(app);

    for (let i = 0; i < 2; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-wrapped")).toBe("prototype");
      expect(await res.text()).toBe("ok");
    }
    expect(calls).toBe(2);
  });

  it("is handed a Request whose rebuilt copy still aborts when the client goes away", async () => {
    // A Request built from another follows the signal the original holds
    // internally, which is only the transport's when the server built it so.
    let calls = 0;
    CelsianApp.prototype.handle = function (this: CelsianApp, request: Request) {
      calls++;
      return original.call(this, new Request(request, { headers: new Headers(request.headers) }));
    };
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

    const client = httpRequest(`http://127.0.0.1:${port}/pending`);
    client.on("error", () => {});
    client.end();
    try {
      await entered.opened;
      expect(calls).toBe(1);
      expect(signal?.aborted).toBe(false);
      client.destroy();
      await expect.poll(() => signal?.aborted, { timeout: 1000 }).toBe(true);
    } finally {
      release.open();
      client.destroy();
    }
  });

  it("leaves an app created before the patch, and one created after, going through it alike", async () => {
    const before = createApp();
    before.get("/", () => "before");
    let calls = 0;
    CelsianApp.prototype.handle = function (this: CelsianApp, request: Request) {
      calls++;
      return original.call(this, request);
    };
    const after = createApp();
    after.get("/", () => "after");

    const portBefore = await listen(before);
    expect(await (await fetch(`http://127.0.0.1:${portBefore}/`)).text()).toBe("before");
    await server?.close();
    server = undefined;
    const portAfter = await listen(after);
    expect(await (await fetch(`http://127.0.0.1:${portAfter}/`)).text()).toBe("after");
    expect(calls).toBe(2);
  });
});

describe("what a replaced handle returns", () => {
  it("answers a genuine Promise from another realm", async () => {
    const app = createApp();
    app.get("/", () => "ok");
    const handle = app.handle.bind(app);
    const OtherPromise = runInNewContext("Promise") as PromiseConstructor;
    app.handle = (request: Request) => OtherPromise.resolve(handle(request));
    const port = await listen(app);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("answers a thenable that is not a Promise", async () => {
    const app = createApp();
    app.get("/", () => "ok");
    const handle = app.handle.bind(app);
    app.handle = ((request: Request) => ({
      // biome-ignore lint/suspicious/noThenProperty: a thenable is the point of the test
      then: (resolve: (value: Response) => void, reject: (reason: unknown) => void) =>
        handle(request).then(resolve, reject),
    })) as unknown as CelsianApp["handle"];
    const port = await listen(app);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("answers a Response returned without a promise", async () => {
    const app = createApp();
    app.handle = (() => new Response("direct", { status: 202 })) as unknown as CelsianApp["handle"];
    const port = await listen(app);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("direct");
  });

  it("answers 500 for a handle that throws, or rejects from another realm", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const OtherPromise = runInNewContext("Promise") as PromiseConstructor;
    for (const replaced of [
      () => {
        throw new Error("sync");
      },
      () => OtherPromise.reject(new Error("async")),
    ]) {
      const app = createApp();
      app.handle = replaced as unknown as CelsianApp["handle"];
      const port = await listen(app);
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
      await server?.close();
      server = undefined;
    }
  });
});
