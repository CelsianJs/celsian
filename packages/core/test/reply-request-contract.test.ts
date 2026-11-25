// @celsian/core -- the contract for wrapping and inspecting `reply` and `request`
//
// packages/core/README.md, "Wrapping and inspecting `reply` and `request`",
// states what is supported. Each test here is one statement of it, in the
// README's order, named after it. Some statements are also covered in more
// depth elsewhere; the file is named beside the test.

import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, CelsianApp as CelsianAppClass, createApp } from "../src/app.js";
import { createReply } from "../src/reply.js";
import { type ServeResult, serve } from "../src/serve.js";
import type { CelsianReply, CelsianRequest } from "../src/types.js";

let server: ServeResult | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function listen(app: CelsianApp): Promise<number> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  let port = 0;
  server = await serve(app, {
    port: 0,
    host: "127.0.0.1",
    handleFatalErrors: false,
    shutdownTimeout: 100,
    onReady: (info) => {
      port = info.port;
    },
  });
  return port;
}

/**
 * Run `run` as a route's handler, through inject(), and give back what it
 * answered. Whatever `run` throws, a failed expectation included, is thrown
 * here: the app would otherwise answer it with a 500 and the test would pass.
 */
async function seen(
  run: (request: CelsianRequest, reply: CelsianReply) => unknown,
  setup?: (app: CelsianApp) => void,
): Promise<Response> {
  const app = createApp();
  setup?.(app);
  let thrown: { error: unknown } | undefined;
  app.get("/", (request, reply) => {
    try {
      return run(request, reply) as Response;
    } catch (error) {
      thrown = { error };
      throw error;
    }
  });
  const res = await app.inject({ url: "/" });
  if (thrown !== undefined) throw thrown.error;
  return res;
}

describe("reply", () => {
  it("reading and assigning: statusCode, sent and headers read and set its state; headers is live; an assigned method replaces it on that reply only", async () => {
    const other = createReply("http://localhost/");
    const res = await seen((_request, reply) => {
      expect([reply.statusCode, reply.sent]).toEqual([200, false]);
      reply.sent = true;
      expect(reply.sent).toBe(true);
      reply.sent = false;
      reply.statusCode = 201;
      reply.headers["x-live"] = "1";
      const send = reply.send;
      reply.send = (data: unknown) => send(`wrapped ${String(data)}`);
      expect(other.send).not.toBe(reply.send);
      return reply.send("body");
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-live")).toBe("1");
    expect(await res.text()).toBe("wrapped body");
  });

  it("detached methods: a method read off the reply acts on it on its own, is the same function each time, is named bound and has length 3", async () => {
    const res = await seen((_request, reply) => {
      const { status, header, json } = reply;
      expect(reply.json).toBe(reply.json);
      expect([json.name, json.length]).toEqual(["bound", 3]);
      status(202);
      header("x-detached", "yes");
      return json({ ok: true });
    });
    expect(res.status).toBe(202);
    expect(res.headers.get("x-detached")).toBe("yes");
  });

  it("in, for...in and Object.keys(): in and for...in see statusCode, sent, headers and every method; Object.keys() lists only decorations and assigned methods", async () => {
    await seen(
      (_request, reply) => {
        for (const name of ["statusCode", "sent", "headers", "status", "json", "send", "cookie", "notFound"]) {
          expect(name in reply).toBe(true);
        }
        const listed: string[] = [];
        for (const key in reply) listed.push(key);
        expect(listed).toEqual(expect.arrayContaining(["statusCode", "sent", "headers", "status", "json", "redirect"]));
        reply.send = reply.send.bind(reply);
        expect(Object.keys(reply).sort()).toEqual(["decorated", "send"]);
        return "ok";
      },
      (app) => app.decorateReply("decorated", 1),
    );
  });

  it("JSON.stringify(reply) gives statusCode, headers and sent, then decorations", async () => {
    await seen(
      (_request, reply) => {
        reply.status(203).header("x-a", "1");
        expect(JSON.stringify(reply)).toBe('{"statusCode":203,"headers":{"x-a":"1"},"sent":false,"decorated":1}');
        return "ok";
      },
      (app) => app.decorateReply("decorated", 1),
    );
  });

  it("Object.create(reply), and Object.create() of that again, act on the reply, by method and by assignment", async () => {
    // reply-detached-methods.test.ts, "an object that inherits from a reply", covers more.
    const res = await seen((_request, reply) => {
      const once = Object.create(reply) as CelsianReply;
      const twice = Object.create(once) as CelsianReply;
      twice.status(206);
      once.header("x-wrapper", "1");
      twice.sent = true;
      expect([reply.statusCode, reply.sent, reply.headers["x-wrapper"]]).toEqual([206, true, "1"]);
      once.statusCode = 207;
      return twice.send("through a wrapper");
    });
    expect(res.status).toBe(207);
    expect(await res.text()).toBe("through a wrapper");
  });

  it.each([
    ["no traps", (reply: CelsianReply) => new Proxy(reply, {})],
    [
      "get and set traps that forward with the receiver",
      (reply: CelsianReply) =>
        new Proxy(reply, {
          get: (target, key, receiver) => Reflect.get(target, key, receiver),
          set: (target, key, value, receiver) => Reflect.set(target, key, value, receiver),
        }),
    ],
    [
      "get and set traps that forward without it",
      (reply: CelsianReply) =>
        new Proxy(reply, {
          get: (target, key) => Reflect.get(target, key),
          set: (target, key, value) => Reflect.set(target, key, value),
        }),
    ],
    ["an Object.create() of a proxy", (reply: CelsianReply) => Object.create(new Proxy(reply, {})) as CelsianReply],
    ["a proxy of an Object.create()", (reply: CelsianReply) => new Proxy(Object.create(reply) as CelsianReply, {})],
  ])("a transparent Proxy acts on the reply: %s", async (_label, wrap) => {
    // reply-detached-methods.test.ts, "a stand-in for the reply, on a real route", covers more.
    const res = await seen((_request, reply) => {
      const proxy = wrap(reply);
      proxy.statusCode = 206;
      proxy.header("x-proxy", "1");
      return proxy.send("through a proxy");
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("x-proxy")).toBe("1");
    expect(await res.text()).toBe("through a proxy");
  });

  it.each([
    [
      "a proxy whose get trap hides symbols",
      (reply: CelsianReply) =>
        new Proxy(reply, {
          get: (target, key, receiver) => (typeof key === "symbol" ? undefined : Reflect.get(target, key, receiver)),
        }),
    ],
    [
      "a membrane",
      (reply: CelsianReply) => {
        const wrapped = new WeakMap<object, unknown>();
        const wrap = (value: unknown): unknown => {
          if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
          if (!wrapped.has(value as object)) {
            wrapped.set(
              value as object,
              new Proxy(value as object, { get: (target, key, receiver) => wrap(Reflect.get(target, key, receiver)) }),
            );
          }
          return wrapped.get(value as object);
        };
        return wrap(reply) as CelsianReply;
      },
    ],
  ])("not supported: %s; through one, statusCode, sent and every method read as undefined", async (_label, wrap) => {
    await seen((_request, reply) => {
      const proxy = wrap(reply);
      expect([proxy.statusCode, proxy.sent, proxy.status, proxy.json, proxy.send]).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      return "ok";
    });
  });

  it("spread and Object.assign() copy its decorations, assigned methods and internal symbol-keyed fields; the copy has none of the reply's methods and is not a reply", async () => {
    await seen(
      (_request, reply) => {
        const assigned = () => new Response("assigned");
        reply.html = assigned;
        for (const copy of [{ ...reply }, Object.assign({}, reply)] as unknown as Record<string, unknown>[]) {
          expect(Object.keys(copy).sort()).toEqual(["decorated", "html"]);
          expect(copy.html).toBe(assigned);
          expect([copy.status, copy.json, copy.statusCode]).toEqual([undefined, undefined, undefined]);
          expect(Object.getOwnPropertySymbols(copy).map((key) => key.description)).not.toContain("celsian.reply.self");
        }
        return "ok";
      },
      (app) => app.decorateReply("decorated", 1),
    );
  });

  it("structuredClone(reply) gives a plain object with its decorations, and throws a DataCloneError when one is a function", async () => {
    await seen(
      (_request, reply) => {
        const clone = structuredClone(reply);
        expect(clone).toEqual({ decorated: 1 });
        expect(Object.getPrototypeOf(clone)).toBe(Object.prototype);
        reply.send = reply.send.bind(reply);
        expect(() => structuredClone(reply)).toThrow(expect.objectContaining({ name: "DataCloneError" }));
        return "ok";
      },
      (app) => app.decorateReply("decorated", 1),
    );
  });

  it("not supported: copying its symbol-keyed properties onto another object; a copy by assignment does not act on the reply, and assigning to its own slot throws a TypeError", async () => {
    // reply-detached-methods.test.ts, "the slot a reply holds itself in", covers more.
    await seen((_request, reply) => {
      const copy = Object.create(Object.getPrototypeOf(reply)) as CelsianReply & Record<symbol, unknown>;
      for (const key of Object.getOwnPropertySymbols(reply))
        copy[key] = (reply as unknown as Record<symbol, unknown>)[key];
      expect(copy.status).toBeUndefined();
      const slot = Object.getOwnPropertySymbols(reply).find((key) => key.description === "celsian.reply.self");
      expect(() => {
        (reply as unknown as Record<symbol, unknown>)[slot as symbol] = {};
      }).toThrow(TypeError);
      return "ok";
    });
  });
});

describe("request, as a route sees it", () => {
  it("method, url, headers, params, query and parsedBody are own properties, as are ip and decorations; cookies, signal, body, bodyUsed and the body methods are on its prototype, which reading, destructuring, in and for...in see and Object.keys(), a spread and JSON.stringify() do not", async () => {
    await seen(
      (request) => {
        const own = Object.keys(request);
        expect(own).toEqual(
          expect.arrayContaining(["method", "url", "headers", "params", "query", "parsedBody", "ip", "decorated"]),
        );
        const inherited = [
          "cookies",
          "signal",
          "body",
          "bodyUsed",
          "json",
          "text",
          "formData",
          "arrayBuffer",
          "blob",
          "clone",
        ];
        for (const name of inherited) {
          expect(Object.hasOwn(request, name), name).toBe(false);
          expect(name in request, name).toBe(true);
        }
        const listed: string[] = [];
        for (const key in request) listed.push(key);
        expect(listed).toEqual(expect.arrayContaining(inherited));
        const { signal, cookies } = request;
        expect([signal instanceof AbortSignal, typeof cookies]).toEqual([true, "object"]);
        expect(Object.keys({ ...request })).toEqual(own);
        expect(Object.keys(JSON.parse(JSON.stringify(request)))).not.toContain("signal");
        return "ok";
      },
      (app) => app.decorateRequest("decorated", 1),
    );
  });

  it("structuredClone(request) throws a DataCloneError on Node 22 and later, and gives a plain object that is not a request on Node 20", async () => {
    // Its headers are a Headers object, which Node 22 and later refuse to clone and Node 20 clones as a plain object.
    const node = Number(process.versions.node.split(".")[0]);
    await seen((request) => {
      if (node >= 22) {
        expect(() => structuredClone(request)).toThrow(expect.objectContaining({ name: "DataCloneError" }));
      } else {
        const clone = structuredClone(request) as unknown as Record<string, unknown>;
        expect([Object.getPrototypeOf(clone), clone.json, clone.signal]).toEqual([
          Object.prototype,
          undefined,
          undefined,
        ]);
      }
      return "ok";
    });
  });

  it("is not a Request: new Request(request, init) throws a TypeError, and new Request(request.url, request) has its method, headers and signal", async () => {
    await seen((request) => {
      expect(request instanceof Request).toBe(false);
      expect(() => new Request(request as unknown as Request, { headers: { "x-a": "1" } })).toThrow(TypeError);
      const rebuilt = new Request(request.url, request as unknown as RequestInit);
      expect(rebuilt.method).toBe("GET");
      expect([...rebuilt.headers]).toEqual([...request.headers]);
      expect(rebuilt.signal.aborted).toBe(false);
      return "ok";
    }).then(async (res) => expect(res.status).toBe(200));
  });

  it("clone() through inject(), and through app.handle() given a plain Request, is a plain Request", async () => {
    await seen((request) => {
      const copy = request.clone();
      expect([copy.constructor, copy instanceof Request]).toEqual([Request, true]);
      return "ok";
    });
    const app = createApp();
    let made: unknown;
    app.get("/", (request) => {
      made = request.clone().constructor;
      return "ok";
    });
    await app.handle(new Request("http://localhost/"));
    expect(made).toBe(Request);
  });

  it("clone() on serve() is a Request subclass named NodeRequest, whose signal, and that of a Request built from it, aborts when the client disconnects", async () => {
    // serve-transport-signal.test.ts covers clones of clones and the copy's body.
    const app = createApp({ requestTimeout: 0 });
    const heard: string[] = [];
    let shape: unknown[] = [];
    let entered = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.get("/", (request) => {
      const copy = request.clone();
      shape = [copy.constructor.name, copy instanceof Request];
      const rebuilt = new Request(copy, { headers: { "x-a": "1" } });
      copy.signal.addEventListener("abort", () => heard.push("clone"));
      rebuilt.signal.addEventListener("abort", () => heard.push("rebuilt"));
      entered();
      return new Promise<never>(() => {});
    });
    const port = await listen(app);
    const socket = connect({ port, host: "127.0.0.1" }, () => socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    socket.on("error", () => {});
    await inside;
    expect(shape).toEqual(["NodeRequest", true]);
    socket.destroy();
    await expect.poll(() => [...heard].sort(), { timeout: 2000 }).toEqual(["clone", "rebuilt"]);
  });

  it("an unmatched request's hooks and the not-found handler see a request built the 0.6.7 way, with everything an own property", async () => {
    const app = createApp();
    let shape: string[] = [];
    app.setNotFoundHandler((request, reply) => {
      shape = ["signal", "json", "clone"].filter((name) => Object.hasOwn(request, name));
      return reply.status(404).send("missing");
    });
    expect((await app.inject({ url: "/nowhere" })).status).toBe(404);
    expect(shape).toEqual(["signal", "json", "clone"]);
  });
});

describe("replacing app.handle", () => {
  const original = CelsianAppClass.prototype.handle;
  afterEach(() => {
    CelsianAppClass.prototype.handle = original;
  });

  it.each([
    ["on the instance", "instance"],
    ["on CelsianApp.prototype", "prototype"],
    ["in a subclass", "subclass"],
  ] as const)(
    "serve() goes through a handle replaced %s, once per request, with the app as this",
    async (_label, where) => {
      // serve-handle-override.test.ts covers more.
      let calls = 0;
      let receiver: unknown;
      function wrapped(this: CelsianApp, request: Request): Promise<Response> {
        calls++;
        receiver = this;
        return original.call(this, request);
      }
      let app: CelsianApp;
      if (where === "subclass") {
        app = new (class extends CelsianAppClass {
          override handle(request: Request): Promise<Response> {
            return wrapped.call(this, request);
          }
        })();
      } else {
        if (where === "prototype") CelsianAppClass.prototype.handle = wrapped;
        app = createApp();
        if (where === "instance") app.handle = wrapped;
      }
      app.get("/", () => "ok");
      const port = await listen(app);
      for (let i = 0; i < 2; i++) expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
      expect(calls).toBe(2);
      expect(receiver).toBe(app);
    },
  );

  it("answers what it returns: a Response, a thenable of one, a promise from another realm; 500 for a throw or a rejection", async () => {
    const { runInNewContext } = await import("node:vm");
    const foreignPromise = runInNewContext("Promise") as PromiseConstructor;
    for (const [handle, status] of [
      [() => new Response("direct", { status: 201 }), 201],
      [
        () => ({
          // biome-ignore lint/suspicious/noThenProperty: a thenable is the point of the test
          then: (resolve: (r: Response) => void) => resolve(new Response("thenable", { status: 202 })),
        }),
        202,
      ],
      [() => foreignPromise.resolve(new Response("foreign", { status: 203 })), 203],
      [
        () => {
          throw new Error("thrown");
        },
        500,
      ],
      [() => Promise.reject(new Error("rejected")), 500],
    ] as const) {
      const app = createApp();
      app.handle = handle as unknown as CelsianApp["handle"];
      const port = await listen(app);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(status);
      await server?.close();
      server = undefined;
    }
  });

  it("hands the handle a Request whose signal, and that of one rebuilt with new Request(request, init), aborts when the client disconnects", async () => {
    // serve-transport-signal.test.ts covers this with and without a request timeout.
    const app = createApp();
    const heard: string[] = [];
    let entered = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.get("/", () => {
      entered();
      return new Promise<never>(() => {});
    });
    const stock = app.handle.bind(app);
    app.handle = (request: Request) => {
      const rebuilt = new Request(request, { headers: { "x-a": "1" } });
      request.signal.addEventListener("abort", () => heard.push("given"));
      rebuilt.signal.addEventListener("abort", () => heard.push("rebuilt"));
      return stock(rebuilt);
    };
    const port = await listen(app);
    const socket = connect({ port, host: "127.0.0.1" }, () => socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    socket.on("error", () => {});
    await inside;
    socket.destroy();
    await expect.poll(() => [...heard].sort(), { timeout: 2000 }).toEqual(["given", "rebuilt"]);
  });
});

describe("request.signal", () => {
  /** request.signal as a route sees it for `input`, and the app. */
  async function signalFor(input: Request, requestTimeout?: number): Promise<{ signal: AbortSignal; app: CelsianApp }> {
    const app = createApp(requestTimeout === undefined ? {} : { requestTimeout });
    let signal: AbortSignal | undefined;
    app.get("/", (request) => {
      signal = request.signal;
      return "ok";
    });
    await app.handle(input);
    return { signal: signal as AbortSignal, app };
  }

  it("without a request timeout, is the signal of the Request the app was given", async () => {
    const input = new Request("http://localhost/", { signal: new AbortController().signal });
    expect((await signalFor(input, 0)).signal).toBe(input.signal);
  });

  it("with one, is a signal of its own, which aborts with the input's reason, or with the 504 HttpError when the timeout fires; the timeout never aborts the input", async () => {
    const source = new AbortController();
    const input = new Request("http://localhost/", { signal: source.signal });
    const { signal } = await signalFor(input);
    expect(signal).not.toBe(input.signal);
    source.abort("gone");
    expect(signal.reason).toBe("gone");

    const app = createApp({ requestTimeout: 15 });
    let timed: AbortSignal | undefined;
    app.get("/", (request) => {
      timed = request.signal;
      return new Promise<never>(() => {});
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const quiet = new Request("http://localhost/", { signal: new AbortController().signal });
    expect((await app.handle(quiet)).status).toBe(504);
    expect((timed?.reason as { statusCode?: number } | undefined)?.statusCode).toBe(504);
    expect(quiet.signal.aborted).toBe(false);
  });

  it("aborts when the input does even after an earlier listener on the input stopped the event (Node 20.3 and later)", async () => {
    // request-signal-input.test.ts covers Node before 20.16 and without AbortSignal.any.
    const source = new AbortController();
    const input = new Request("http://localhost/", { signal: source.signal });
    input.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
    const { signal } = await signalFor(input);
    source.abort("stopped");
    expect([signal.aborted, signal.reason]).toEqual([true, "stopped"]);
  });

  it("is not aborted by an abort event dispatched on an input that has not aborted, and aborts with the real reason later", async () => {
    const source = new AbortController();
    const input = new Request("http://localhost/", { signal: source.signal });
    const { signal } = await signalFor(input);
    input.signal.dispatchEvent(new Event("abort"));
    expect(signal.aborted).toBe(false);
    source.abort("real");
    expect(signal.reason).toBe("real");
  });

  it("on Node, aborts just after the input's own abort listeners have run: inside one, it is not aborted yet", async () => {
    const source = new AbortController();
    const input = new Request("http://localhost/", { signal: source.signal });
    let signal: AbortSignal | undefined;
    const during: boolean[] = [];
    input.signal.addEventListener("abort", () => during.push(signal?.aborted === true));
    signal = (await signalFor(input)).signal;
    source.abort();
    expect([during, signal.aborted]).toEqual([[false], true]);
  });

  it("on Deno and Cloudflare Workers, is AbortSignal.any() of the input and the timeout, so already aborted inside the input's own abort listeners", async () => {
    // Loaded as core sees Deno. The ordering is the runtime's AbortSignal.any():
    // Node's follows it from Node 22 (Node 20 aborts such a signal after the
    // input's listeners), and packages/adapter-deno/deno-smoke.ts and
    // scripts/workerd-smoke.mjs check it under Deno and workerd themselves.
    const realAny = AbortSignal.any;
    const combined: AbortSignal[][] = [];
    const made: AbortSignal[] = [];
    AbortSignal.any = (signals: AbortSignal[]) => {
      combined.push([...signals]);
      const signal = realAny.call(AbortSignal, signals);
      made.push(signal);
      return signal;
    };
    try {
      vi.stubGlobal("navigator", { userAgent: "Deno/2.9.8" });
      vi.resetModules();
      const { createApp: createAppOnDeno } = await import("../src/app.js");
      const source = new AbortController();
      const input = new Request("http://localhost/", { signal: source.signal });
      let signal: AbortSignal | undefined;
      const during: boolean[] = [];
      input.signal.addEventListener("abort", () => during.push(signal?.aborted === true));
      const app = createAppOnDeno();
      app.get("/", (request) => {
        signal = request.signal;
        return "ok";
      });
      await app.handle(input);
      expect(made).toEqual([signal]);
      expect(combined[0]?.[0]).toBe(input.signal);
      expect(combined[0]).toHaveLength(2);
      source.abort();
      if (Number(process.versions.node.split(".")[0]) >= 22) expect(during).toEqual([true]);
      expect(signal?.aborted).toBe(true);
    } finally {
      AbortSignal.any = realAny;
    }
  });

  it("is already aborted, with the input's reason, when the input aborted before the request", async () => {
    const source = new AbortController();
    source.abort("before");
    const { signal } = await signalFor(new Request("http://localhost/", { signal: source.signal }));
    expect([signal.aborted, signal.reason]).toEqual([true, "before"]);
  });

  it("lifetime: kept alive by its input after the handler returned, unless the input is shared by several requests", async () => {
    // request-signal-input.test.ts covers this with collection forced, over a
    // real socket, and for a shared input with only listeners.
    const source = new AbortController();
    const input = new Request("http://localhost/", { signal: source.signal });
    const heard: unknown[] = [];
    const app = createApp();
    app.get("/", (request) => {
      request.signal.addEventListener("abort", function (this: AbortSignal) {
        heard.push(this.reason);
      });
      return "ok";
    });
    await app.handle(input);
    source.abort("later");
    expect(heard).toEqual(["later"]);
  });

  it("on serve(), first read after the request was answered, reports whether the client had gone by then", async () => {
    // serve-transport-signal.test.ts covers both outcomes.
    const app = createApp({ requestTimeout: 0 });
    let held: CelsianRequest | undefined;
    app.get("/", (request) => {
      held = request;
      return "ok";
    });
    const port = await listen(app);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    expect(held?.signal.aborted).toBe(false);
  });
});
