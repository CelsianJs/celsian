// @celsian/core -- the lifecycle gives the same answers whether its steps are synchronous or not
//
// The lifecycle used to be one async function that awaited every step. It now
// runs straight through while hooks and the handler return plain values, and
// only switches to promises at the first step that returns one. Each case here
// runs with every hook synchronous, every hook asynchronous, and hooks
// returning a non-native thenable, and expects the same response and the same
// order of calls from all three.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { type ServeResult, serve } from "../src/serve.js";
import type { CelsianReply, CelsianRequest, HookHandler } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

type Step = (request: CelsianRequest, reply: CelsianReply) => unknown;

/** How a step hands its result back. */
const MODES = {
  sync:
    (step: Step): HookHandler =>
    (request, reply) =>
      step(request, reply) as Response | undefined,
  async:
    (step: Step): HookHandler =>
    async (request, reply) => {
      await Promise.resolve();
      return step(request, reply) as Response | undefined;
    },
  thenable:
    (step: Step): HookHandler =>
    (request, reply) =>
      ({
        // biome-ignore lint/suspicious/noThenProperty: a hand-made thenable is the point of this mode
        then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
          try {
            resolve(step(request, reply));
          } catch (error) {
            reject(error);
          }
        },
      }) as unknown as Promise<Response | undefined>,
};

const modes = Object.keys(MODES) as (keyof typeof MODES)[];

describe.each(modes)("lifecycle with %s steps", (mode) => {
  const wrap = MODES[mode];

  it("runs every stage in order, once", async () => {
    const order: string[] = [];
    const app = createApp();
    for (const stage of [
      "onRequest",
      "preParsing",
      "preValidation",
      "preHandler",
      "preSerialization",
      "onSend",
    ] as const) {
      app.addHook(
        stage,
        wrap(() => {
          order.push(`${stage}:1`);
        }),
      );
      app.addHook(
        stage,
        wrap(() => {
          order.push(`${stage}:2`);
        }),
      );
    }
    app.post(
      "/x",
      wrap((req) => {
        order.push("handler");
        return { got: req.parsedBody };
      }),
    );

    const response = await app.inject({ method: "POST", url: "/x", payload: { a: 1 } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ got: { a: 1 } });
    expect(order).toEqual([
      "onRequest:1",
      "onRequest:2",
      "preParsing:1",
      "preParsing:2",
      "preValidation:1",
      "preValidation:2",
      "preHandler:1",
      "preHandler:2",
      "handler",
      "preSerialization:1",
      "preSerialization:2",
      "onSend:1",
      "onSend:2",
    ]);
  });

  it.each(["onRequest", "preParsing", "preValidation", "preHandler"] as const)(
    "stops at a Response returned from %s",
    async (stage) => {
      const order: string[] = [];
      const app = createApp();
      app.addHook(
        stage,
        wrap((_req, reply) => {
          order.push("first");
          reply.header("x-early", stage);
          return new Response("stopped", { status: 401 });
        }),
      );
      app.addHook(
        stage,
        wrap(() => {
          order.push("second");
        }),
      );
      app.get("/x", () => {
        order.push("handler");
        return { reached: true };
      });

      const response = await app.inject({ url: "/x" });
      expect(response.status).toBe(401);
      expect(response.headers.get("x-early")).toBe(stage);
      expect(await response.text()).toBe("stopped");
      expect(order).toEqual(["first"]);
    },
  );

  it("stops at a hook that sent through the reply without returning it", async () => {
    const app = createApp();
    app.addHook(
      "onRequest",
      wrap((_req, reply) => {
        reply.status(403).json({ blocked: true });
      }),
    );
    let reached = false;
    app.get("/x", () => {
      reached = true;
      return { reached };
    });

    const response = await app.inject({ url: "/x" });
    expect(response.status).toBe(403);
    expect(reached).toBe(false);
  });

  it("answers a throw from any stage through the error handler, then onSend", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const stage of ["onRequest", "preParsing", "preValidation", "preHandler", "handler", "preSerialization"]) {
      const app = createApp();
      const seen: string[] = [];
      app.addHook("onError", (error) => {
        seen.push(`onError:${error.message}`);
      });
      app.addHook(
        "onSend",
        wrap((_req, reply) => {
          seen.push(`onSend:${reply.statusCode}`);
          reply.header("x-sent", "1");
        }),
      );
      const fail: Step = () => {
        throw new Error(`from ${stage}`);
      };
      if (stage === "handler") app.get("/x", wrap(fail));
      else {
        app.addHook(stage as "onRequest", wrap(fail));
        app.get("/x", () => ({ ok: true }));
      }

      const response = await app.inject({ url: "/x" });
      expect(response.status, stage).toBe(500);
      expect(response.headers.get("x-sent"), stage).toBe("1");
      expect(await response.json(), stage).toMatchObject({ error: `from ${stage}`, statusCode: 500 });
      // One onError call, and onSend last, shown the status actually sent.
      expect(
        seen.filter((entry) => entry.startsWith("onError")),
        stage,
      ).toEqual([`onError:from ${stage}`]);
      expect(seen.at(-1), stage).toBe("onSend:500");
    }
  });

  it("lets an onError hook answer, and falls through one that throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp();
    app.addHook(
      "onError",
      wrap(() => {
        throw new Error("broken hook");
      }) as never,
    );
    app.addHook("onError", wrap(() => new Response("handled by hook", { status: 418 })) as never);
    app.get("/x", () => {
      throw new Error("boom");
    });

    const response = await app.inject({ url: "/x" });
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("handled by hook");
  });

  it("uses a custom error handler's Response, and the default when it throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handled = createApp();
    handled.setErrorHandler(wrap(() => new Response("custom", { status: 502 })) as never);
    handled.get("/x", () => {
      throw new Error("boom");
    });
    const first = await handled.inject({ url: "/x" });
    expect(first.status).toBe(502);
    expect(await first.text()).toBe("custom");

    const broken = createApp();
    broken.setErrorHandler(
      wrap(() => {
        throw new Error("handler is broken too");
      }) as never,
    );
    broken.get("/x", () => {
      throw new Error("boom");
    });
    const second = await broken.inject({ url: "/x" });
    expect(second.status).toBe(500);
    expect(await second.json()).toMatchObject({ error: "boom" });
  });

  it("sends the response anyway when an onSend hook throws, and logs it", async () => {
    const errors: string[] = [];
    const app = createApp({
      logger: {
        level: "info",
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error: (message: string) => errors.push(message),
        fatal() {},
        child() {
          return this;
        },
      } as never,
    });
    app.addHook(
      "onSend",
      wrap((_req, reply) => {
        reply.header("x-before-throw", "1");
        throw new Error("onSend broke");
      }),
    );
    app.get("/x", () => ({ ok: true }));

    const response = await app.inject({ url: "/x" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // Headers from a chain that failed are not merged.
    expect(response.headers.get("x-before-throw")).toBeNull();
    expect(errors).toContain("onSend hook error");
  });

  it("serializes whatever the handler resolves to", async () => {
    const app = createApp();
    app.get(
      "/object",
      wrap(() => ({ a: 1 })),
    );
    app.get(
      "/string",
      wrap(() => "text"),
    );
    app.get(
      "/nothing",
      wrap(() => undefined),
    );
    app.get(
      "/null",
      wrap(() => null),
    );
    app.get(
      "/response",
      wrap(() => new Response("raw", { status: 202 })),
    );
    app.get(
      "/reply",
      wrap((_req, reply) => reply.status(201).json({ made: true })),
    );
    app.get(
      "/sent-not-returned",
      wrap((_req, reply) => {
        reply.status(202).send("ignored body");
      }),
    );

    const get = async (url: string) => {
      const response = await app.inject({ url });
      return [response.status, response.headers.get("content-type"), await response.text()];
    };
    expect(await get("/object")).toEqual([200, "application/json; charset=utf-8", '{"a":1}']);
    expect(await get("/string")).toEqual([200, "text/plain; charset=utf-8", "text"]);
    expect(await get("/nothing")).toEqual([204, null, ""]);
    expect(await get("/null")).toEqual([204, null, ""]);
    expect(await get("/response")).toEqual([202, "text/plain;charset=UTF-8", "raw"]);
    expect(await get("/reply")).toEqual([201, "application/json; charset=utf-8", '{"made":true}']);
    expect(await get("/sent-not-returned")).toEqual([202, null, ""]);
  });

  it("runs the miss guards, the notFound handler and onSend for an unknown path", async () => {
    const app = createApp();
    const order: string[] = [];
    app.addHook(
      "onRequest",
      wrap(() => {
        order.push("onRequest");
      }),
    );
    app.addHook(
      "onSend",
      wrap((_req, reply) => {
        order.push(`onSend:${reply.statusCode}`);
        reply.header("x-sent", "1");
      }),
    );
    app.get("/known", () => ({ ok: true }));

    const missing = await app.inject({ url: "/unknown" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-sent")).toBe("1");
    expect(await missing.json()).toEqual({ error: "Not Found", statusCode: 404, code: "NOT_FOUND" });

    const wrongMethod = await app.inject({ method: "DELETE", url: "/known" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD");
    expect(wrongMethod.headers.get("x-sent")).toBe("1");
    expect(order).toEqual(["onRequest", "onSend:404", "onRequest", "onSend:405"]);

    app.setNotFoundHandler(wrap((_req, reply) => reply.status(404).json({ custom: true })) as never);
    const custom = await app.inject({ url: "/unknown" });
    expect(custom.status).toBe(404);
    expect(custom.headers.get("x-sent")).toBe("1");
    expect(await custom.json()).toEqual({ custom: true });
  });

  it("lets a guard answer an unknown path before the 404", async () => {
    const app = createApp();
    app.addHook(
      "onRequest",
      wrap(() => new Response(null, { status: 401 })),
    );

    expect((await app.inject({ url: "/unknown" })).status).toBe(401);
  });
});

describe("a lifecycle that mixes synchronous and asynchronous steps", () => {
  it("keeps the order when only some hooks are asynchronous", async () => {
    const order: string[] = [];
    const app = createApp();
    app.addHook("onRequest", () => {
      order.push("sync 1");
    });
    app.addHook("onRequest", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("async 2");
    });
    app.addHook("onRequest", () => {
      order.push("sync 3");
    });
    app.addHook("onSend", async () => {
      await Promise.resolve();
      order.push("onSend async");
    });
    app.addHook("onSend", () => {
      order.push("onSend sync");
    });
    app.get("/x", () => {
      order.push("handler");
      return { ok: true };
    });

    expect((await app.inject({ url: "/x" })).status).toBe(200);
    expect(order).toEqual(["sync 1", "async 2", "sync 3", "handler", "onSend async", "onSend sync"]);
  });

  it("waits for plugins that are still registering", async () => {
    const app = createApp();
    void app.register(async (plugin) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      plugin.get("/late", () => ({ late: true }));
    });

    const response = await app.handle(new Request("http://localhost/late"));
    expect(await response.json()).toEqual({ late: true });
  });

  it("handle() always returns a promise, and rejects rather than throws", async () => {
    const app = createApp();
    app.addHook("onRequest", () => {
      throw new Error("guard exploded");
    });

    // A miss has no error handler: the failure reaches the caller of handle().
    let thrown: unknown;
    let result: unknown;
    try {
      result = app.handle(new Request("http://localhost/unknown"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow("guard exploded");
  });
});

describe("the Node server writes a synchronous answer without waiting", () => {
  let server: ServeResult | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function listen(app: CelsianApp): Promise<string> {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let port = 0;
    server = await serve(app, {
      port: 0,
      host: "127.0.0.1",
      onReady: (info) => {
        port = info.port;
      },
    });
    return `http://127.0.0.1:${port}`;
  }

  it("answers synchronous, asynchronous, body, miss and error requests over one connection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp();
    app.get("/sync", (_req, reply) => reply.json({ kind: "sync" }));
    app.get("/async", async (_req, reply) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return reply.json({ kind: "async" });
    });
    app.post("/echo", (req, reply) => reply.json(req.parsedBody));
    app.delete("/no-body", (req, reply) => reply.json({ parsed: req.parsedBody ?? null }));
    app.get("/boom", () => {
      throw new Error("boom");
    });
    app.get("/stream", () => new Response("streamed"));
    const base = await listen(app);

    // Twice round, so every kind of answer follows every other kind on the keep-alive socket.
    for (let round = 0; round < 2; round++) {
      expect(await (await fetch(`${base}/sync`)).json()).toEqual({ kind: "sync" });
      expect(await (await fetch(`${base}/async`)).json()).toEqual({ kind: "async" });
      const echoed = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: round }),
      });
      expect(await echoed.json()).toEqual({ n: round });
      expect(await (await fetch(`${base}/no-body`, { method: "DELETE" })).json()).toEqual({ parsed: null });
      const missing = await fetch(`${base}/nope`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
      const failed = await fetch(`${base}/boom`);
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ error: "boom" });
      expect(await (await fetch(`${base}/stream`)).text()).toBe("streamed");
    }
  });

  it("answers 500 and keeps serving when a synchronous answer cannot be written", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp();
    // A control character passes reply.header() but Node refuses to put it on the wire.
    app.get("/bad-header", (_req, reply) => reply.header("x-bad", "a\u0001b").json({ ok: true }));
    app.get("/fine", (_req, reply) => reply.json({ ok: true }));
    const base = await listen(app);

    const bad = await fetch(`${base}/bad-header`);
    expect(bad.status).toBe(500);
    expect(await bad.text()).toBe("Internal Server Error");
    expect(errors.mock.calls.some((call) => call[0] === "[celsian] Unhandled error:")).toBe(true);
    expect(await (await fetch(`${base}/fine`)).json()).toEqual({ ok: true });
  });

  it("finishes in-flight accounting for synchronous answers, so shutdown does not wait on them", async () => {
    const app = createApp();
    app.get("/sync", (_req, reply) => reply.json({ ok: true }));
    const base = await listen(app);

    for (let i = 0; i < 5; i++) await (await fetch(`${base}/sync`, { headers: { connection: "close" } })).text();
    const started = Date.now();
    await server?.close();
    server = undefined;
    // Well under the 10 second drain deadline a leaked in-flight count would run into.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
