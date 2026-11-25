// @celsian/core -- reply methods keep working detached from the reply
//
// A reply's methods used to be closures over the request's state, built per
// request. They now live on a prototype and are bound to a reply the first time
// they are read from it. Everything here worked on the closure-based reply and
// has to keep working: destructuring, keeping a reference to wrap a method (the
// compression plugin does this), assigning a replacement, and chaining.

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createReply } from "../src/reply.js";
import type { CelsianReply } from "../src/types.js";

const METHODS = [
  "status",
  "header",
  "send",
  "html",
  "json",
  "stream",
  "redirect",
  "cookie",
  "clearCookie",
  "sendFile",
  "download",
  "notFound",
  "badRequest",
  "unauthorized",
  "forbidden",
  "conflict",
  "gone",
  "tooManyRequests",
  "internalServerError",
  "serviceUnavailable",
] as const;

describe("reply methods detached from the reply", () => {
  it("destructured methods act on the reply they came from", async () => {
    const reply = createReply("http://localhost/");
    const { status, header, cookie, json } = reply;

    status(201);
    header("X-Made", "yes");
    cookie("a", "1", { secure: false });
    const response = json({ made: true });

    expect(reply.statusCode).toBe(201);
    expect(reply.headers["x-made"]).toBe("yes");
    expect(reply.sent).toBe(true);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-made")).toBe("yes");
    expect(response.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual(["a=1"]);
    expect(await response.json()).toEqual({ made: true });
  });

  it("every method can be called detached", async () => {
    const calls: Record<(typeof METHODS)[number], (reply: CelsianReply) => unknown> = {
      status: ({ status }) => status(202),
      header: ({ header }) => header("x-a", "1"),
      send: ({ send }) => send("text"),
      html: ({ html }) => html("<p>hi</p>"),
      json: ({ json }) => json({ a: 1 }),
      stream: ({ stream }) => stream(new ReadableStream()),
      redirect: ({ redirect }) => redirect("/elsewhere"),
      cookie: ({ cookie }) => cookie("a", "1"),
      clearCookie: ({ clearCookie }) => clearCookie("a"),
      sendFile: ({ sendFile }) => sendFile("definitely-not-a-file.txt"),
      download: ({ download }) => download("definitely-not-a-file.txt"),
      notFound: ({ notFound }) => notFound(),
      badRequest: ({ badRequest }) => badRequest(),
      unauthorized: ({ unauthorized }) => unauthorized(),
      forbidden: ({ forbidden }) => forbidden(),
      conflict: ({ conflict }) => conflict(),
      gone: ({ gone }) => gone(),
      tooManyRequests: ({ tooManyRequests }) => tooManyRequests(),
      internalServerError: ({ internalServerError }) => internalServerError(),
      serviceUnavailable: ({ serviceUnavailable }) => serviceUnavailable(),
    };
    const expectedStatus: Partial<Record<(typeof METHODS)[number], number>> = {
      send: 200,
      html: 200,
      json: 200,
      stream: 200,
      redirect: 302,
      sendFile: 404,
      download: 404,
      notFound: 404,
      badRequest: 400,
      unauthorized: 401,
      forbidden: 403,
      conflict: 409,
      gone: 410,
      tooManyRequests: 429,
      internalServerError: 500,
      serviceUnavailable: 503,
    };

    for (const name of METHODS) {
      const reply = createReply("http://localhost/");
      const result = await calls[name](reply);
      const status = expectedStatus[name];
      if (status === undefined) {
        // The chainable ones return the reply they were read from.
        expect(result, name).toBe(reply);
      } else {
        expect(result, name).toBeInstanceOf(Response);
        expect((result as Response).status, name).toBe(status);
      }
    }
  });

  it("hands out the same function every time a method is read", () => {
    const reply = createReply();
    for (const name of METHODS) {
      expect(typeof reply[name], name).toBe("function");
      expect(reply[name], name).toBe(reply[name]);
    }
    // Two replies do not share bound methods.
    expect(createReply().json).not.toBe(reply.json);
  });

  it("keeps two replies' detached methods apart", async () => {
    const first = createReply();
    const second = createReply();
    const firstJson = first.status(201).json;
    const secondJson = second.status(202).json;

    expect((await secondJson({ n: 2 })).status).toBe(202);
    expect((await firstJson({ n: 1 })).status).toBe(201);
    expect(first.sent && second.sent).toBe(true);
  });

  it("chains through status() and header() to the same reply", () => {
    const reply = createReply();
    expect(reply.status(201)).toBe(reply);
    expect(reply.header("x-a", "1")).toBe(reply);
    expect(reply.cookie("a", "1")).toBe(reply);
    expect(reply.clearCookie("a")).toBe(reply);
    expect(reply.status(404).header("x-b", "2").json({}).status).toBe(404);
  });

  it("lets a plugin keep the original method and assign a wrapper", async () => {
    const reply = createReply();
    const originalJson = reply.json;
    const seen: unknown[] = [];
    reply.json = (data: unknown): Response => {
      seen.push(data);
      return originalJson({ wrapped: data });
    };

    const response = reply.status(201).json({ a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ wrapped: { a: 1 } });
    // The error helpers build their response through the reply's own json(), wrapper included.
    expect(await reply.notFound().json()).toEqual({
      wrapped: { error: "Not Found", statusCode: 404, code: "NOT_FOUND" },
    });
    // The replacement is that reply's own, and only that reply's.
    expect(Object.hasOwn(reply, "json")).toBe(true);
    expect(await createReply().json({ a: 1 }).json()).toEqual({ a: 1 });
  });

  it("still exposes every property by name, statusCode and sent as plain values", () => {
    const reply = createReply();
    const listed: string[] = [];
    for (const key in reply) listed.push(key);

    for (const name of [...METHODS, "statusCode", "headers", "sent"]) {
      expect(name in reply, name).toBe(true);
      expect(listed, name).toContain(name);
    }

    expect(reply.statusCode).toBe(200);
    reply.statusCode = 418;
    expect(reply.json({}).status).toBe(418);
    expect(reply.sent).toBe(true);
    reply.sent = false;
    expect(reply.sent).toBe(false);

    // `headers` is the live record, and cannot be swapped for another object.
    reply.headers["x-direct"] = "1";
    expect(reply.json({}).headers.get("x-direct")).toBe("1");
    expect(() => {
      (reply as { headers: unknown }).headers = {};
    }).toThrow(TypeError);
  });

  it("works the same inside a handler", async () => {
    const app = createApp();
    app.get("/x", (_req, reply) => {
      const { header, status, json } = reply;
      header("x-detached", "1");
      status(203);
      return json({ ok: true });
    });
    app.get("/y", (_req, { json }) => json({ fromParams: true }));

    const x = await app.inject({ url: "/x" });
    expect(x.status).toBe(203);
    expect(x.headers.get("x-detached")).toBe("1");
    expect(await x.json()).toEqual({ ok: true });
    expect(await (await app.inject({ url: "/y" })).json()).toEqual({ fromParams: true });
  });

  it("does not let a decoration replace a built-in, and keeps decorations as own properties", async () => {
    const app = createApp();
    app.decorateReply("json", "not a function");
    app.decorateReply("tenant", "acme");
    app.get("/x", (_req, reply) => reply.json({ tenant: reply.tenant, own: Object.hasOwn(reply, "tenant") }));

    expect(await (await app.inject({ url: "/x" })).json()).toEqual({ tenant: "acme", own: true });
  });
});

// A reply's state used to live in closures, not on the object, so an object
// that merely inherits from a reply shared that state. Plugins build such
// per-request wrappers (`Object.create(reply)`) to add or override a method.
describe("an object that inherits from a reply", () => {
  it("sets the reply's own status and sent through its methods", async () => {
    const app = createApp();
    app.get("/wrapped", (_req, reply) => {
      const wrapped = Object.create(reply) as CelsianReply;
      wrapped.status(201).header("x-a", "1");
      wrapped.send("created");
    });

    const res = await app.inject({ url: "/wrapped" });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-a")).toBe("1");
  });

  it("returns what its methods build", async () => {
    const app = createApp();
    app.get("/wrapped", (_req, reply) => {
      const wrapped = Object.create(reply) as CelsianReply;
      wrapped.cookie("a", "1", { secure: false });
      return wrapped.status(202).json({ via: "wrapper" });
    });

    const res = await app.inject({ url: "/wrapped" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ via: "wrapper" });
    expect(res.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual(["a=1"]);
  });

  it("reads and writes statusCode and sent on the reply, in both directions", () => {
    const reply = createReply();
    const wrapped = Object.create(reply) as CelsianReply;
    const twice = Object.create(wrapped) as CelsianReply;

    expect(wrapped.statusCode).toBe(200);
    expect(wrapped.sent).toBe(false);

    wrapped.statusCode = 404;
    expect(reply.statusCode).toBe(404);
    twice.statusCode = 410;
    expect(reply.statusCode).toBe(410);
    expect(wrapped.statusCode).toBe(410);
    reply.statusCode = 201;
    expect(twice.statusCode).toBe(201);

    wrapped.sent = true;
    expect(reply.sent).toBe(true);
    reply.sent = false;
    expect(twice.sent).toBe(false);

    // Nothing was written onto the wrappers themselves.
    expect(Reflect.ownKeys(wrapped)).toEqual([]);
    expect(Reflect.ownKeys(twice)).toEqual([]);
  });

  it("shares headers and method identity with the reply, and chains back to it", () => {
    const reply = createReply();
    const wrapped = Object.create(reply) as CelsianReply;

    // Read through the wrapper first, then through the reply.
    const viaWrapper = wrapped.json;
    expect(reply.json).toBe(viaWrapper);
    expect(wrapped.status(203)).toBe(reply);
    wrapped.header("x-shared", "yes");
    expect(reply.headers["x-shared"]).toBe("yes");
    expect(wrapped.headers).toBe(reply.headers);
    expect(viaWrapper({}).status).toBe(203);
    expect(reply.sent).toBe(true);
  });

  it("keeps a method assigned on the wrapper to the wrapper", async () => {
    const reply = createReply();
    const wrapped = Object.create(reply) as CelsianReply;
    const original = wrapped.json;
    wrapped.json = (data: unknown) => original({ wrapped: data });

    expect(Object.hasOwn(wrapped, "json")).toBe(true);
    expect(await wrapped.json({ a: 1 }).json()).toEqual({ wrapped: { a: 1 } });
    expect(await reply.json({ a: 1 }).json()).toEqual({ a: 1 });
  });
});

// A plugin or a tracing helper may hand a handler a stand-in for the reply
// rather than the reply: an object that inherits from it, or a proxy. Either
// must act on the reply. A proxy has none of the reply's private fields and its
// prototype chain skips the reply, so a check for a private field, or a walk up
// the prototype chain, finds no reply behind it (statusCode, sent and every
// method read as undefined, and the route answered 500).
const STAND_INS: [string, (reply: CelsianReply) => CelsianReply][] = [
  ["Object.create(reply)", (reply) => Object.create(reply) as CelsianReply],
  ["Object.create(Object.create(reply))", (reply) => Object.create(Object.create(reply)) as CelsianReply],
  ["new Proxy(reply, {})", (reply) => new Proxy(reply, {})],
  [
    "a proxy whose get and set traps forward with the receiver",
    (reply) =>
      new Proxy(reply, {
        get: (target, key, receiver) => Reflect.get(target, key, receiver),
        set: (target, key, value, receiver) => Reflect.set(target, key, value, receiver),
      }),
  ],
  [
    "a proxy whose get and set traps forward without the receiver",
    (reply) =>
      new Proxy(reply, {
        get: (target, key) => Reflect.get(target, key),
        set: (target, key, value) => Reflect.set(target, key, value),
      }),
  ],
  ["a proxy of Object.create(reply)", (reply) => new Proxy(Object.create(reply) as CelsianReply, {})],
  ["Object.create() of a proxy", (reply) => Object.create(new Proxy(reply, {})) as CelsianReply],
];

describe("a stand-in for the reply, on a real route", () => {
  it.each(STAND_INS)("%s: methods, status and headers reach the reply", async (_name, standIn) => {
    const app = createApp();
    let seen: Record<string, unknown> = {};
    app.get("/partial", (_req, reply) => {
      const wrapped = standIn(reply);
      seen = {
        statusCode: wrapped.statusCode,
        sent: wrapped.sent,
        sameJson: wrapped.json === reply.json,
        sameHeaders: wrapped.headers === reply.headers,
      };
      wrapped.header("x-app", "kept");
      return wrapped.status(206).send("partial");
    });

    const res = await app.inject({ url: "/partial" });
    expect(seen).toEqual({ statusCode: 200, sent: false, sameJson: true, sameHeaders: true });
    expect(res.status).toBe(206);
    expect(res.headers.get("x-app")).toBe("kept");
    expect(await res.text()).toBe("partial");
  });

  it.each(STAND_INS)("%s: assigned status and a send with no return answer as the reply", async (_name, standIn) => {
    const app = createApp();
    let after: Record<string, unknown> = {};
    app.get("/created", (_req, reply) => {
      const wrapped = standIn(reply);
      wrapped.statusCode = 201;
      wrapped.cookie("a", "1", { secure: false });
      wrapped.send("created");
      after = { reply: reply.statusCode, wrapped: wrapped.statusCode, sent: reply.sent, wrappedSent: wrapped.sent };
    });

    const res = await app.inject({ url: "/created" });
    expect(after).toEqual({ reply: 201, wrapped: 201, sent: true, wrappedSent: true });
    expect(res.status).toBe(201);
    expect(res.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual(["a=1"]);
  });

  it("finds no reply behind an object that only claims to be one", () => {
    const proto = Object.getPrototypeOf(createReply()) as object;
    const impostor = Object.create(proto) as CelsianReply;
    expect(impostor.statusCode).toBeUndefined();
    expect(impostor.json).toBeUndefined();
  });
});

describe("the reply's shape", () => {
  it("gives JSON.stringify the status, headers and sent, then decorations", async () => {
    const reply = createReply();
    reply.status(201).header("x-a", "1");
    expect(JSON.parse(JSON.stringify(reply))).toEqual({ statusCode: 201, headers: { "x-a": "1" }, sent: false });
    expect(Object.keys(JSON.parse(JSON.stringify(reply)))).toEqual(["statusCode", "headers", "sent"]);

    const app = createApp();
    app.decorateReply("tenant", "acme");
    let serialized = "";
    app.get("/x", (_req, reply) => {
      serialized = JSON.stringify(reply);
      return reply.json({});
    });
    await app.inject({ url: "/x" });
    expect(JSON.parse(serialized)).toEqual({ statusCode: 200, headers: {}, sent: false, tenant: "acme" });

    // toJSON is not listed with the reply's properties.
    const listed: string[] = [];
    for (const key in reply) listed.push(key);
    expect(listed).not.toContain("toJSON");
  });

  it("passes a third argument through a detached method", () => {
    const { redirect } = createReply();
    const response = redirect("https://checkout.example.com/pay", 303, { allowedHosts: ["checkout.example.com"] });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://checkout.example.com/pay");
  });

  // The point of the prototype: a request pays for the methods it reads, not
  // for all of them. Undoing that (binding every method when the reply is
  // built) changes nothing a handler can see, and used to be caught only by a
  // GC ceiling with a few percent of margin. This pins it exactly.
  it("builds no method until it is read, and then only that one", () => {
    const ownFunctions = (reply: CelsianReply) =>
      Reflect.ownKeys(reply).filter(
        (key) => typeof (reply as unknown as Record<PropertyKey, unknown>)[key] === "function",
      );

    const a = createReply();
    const b = createReply();
    expect(ownFunctions(a)).toEqual([]);
    expect(Object.keys(a)).toEqual([]);

    // One prototype for every reply, with one accessor per method on it.
    const proto = Object.getPrototypeOf(a) as object;
    expect(Object.getPrototypeOf(b)).toBe(proto);
    for (const name of METHODS) {
      const onA = Object.getOwnPropertyDescriptor(a, name);
      const shared = Object.getOwnPropertyDescriptor(proto, name);
      expect(onA, name).toBeUndefined();
      expect(typeof shared?.get, name).toBe("function");
    }
    for (const name of ["statusCode", "sent", "headers"]) {
      expect(Object.getOwnPropertyDescriptor(a, name), name).toBeUndefined();
      expect(typeof Object.getOwnPropertyDescriptor(proto, name)?.get, name).toBe("function");
    }

    void a.json;
    void a.json;
    expect(ownFunctions(a)).toHaveLength(1);
    void a.status;
    expect(ownFunctions(a)).toHaveLength(2);
    expect(ownFunctions(b)).toEqual([]);
    expect(a.json).not.toBe(b.json);
  });

  it("is not disturbed by reading the accessors off the prototype itself", async () => {
    const proto = Object.getPrototypeOf(createReply()) as Record<string, unknown>;
    // Something enumerating the prototype (a debugger, a deep-equality helper).
    for (const name of [...METHODS, "statusCode", "sent"]) expect(proto[name], name).toBeUndefined();
    proto.statusCode = 500;

    const reply = createReply();
    expect(reply.statusCode).toBe(200);
    expect(await reply.status(201).json({ ok: true }).json()).toEqual({ ok: true });
    expect(reply.statusCode).toBe(201);
  });
});

describe("request.cookies", () => {
  it("parses the Cookie header on first read and returns the same object after", async () => {
    const app = createApp();
    let first: Record<string, string> | undefined;
    let second: Record<string, string> | undefined;
    let inRequest = false;
    app.get("/x", (req, reply) => {
      inRequest = "cookies" in req;
      first = req.cookies;
      second = req.cookies;
      const { cookies } = req;
      return reply.json(cookies);
    });

    const response = await app.inject({ url: "/x", cookies: { a: "1", b: "two words" } });
    expect(await response.json()).toEqual({ a: "1", b: "two words" });
    expect(inRequest).toBe(true);
    expect(first).toBe(second);
  });

  it("is an empty object without a Cookie header, a fresh one per request, and cannot be assigned", async () => {
    const app = createApp();
    const seen: Record<string, string>[] = [];
    let assignment: unknown;
    app.get("/x", (req, reply) => {
      seen.push(req.cookies);
      try {
        (req as { cookies: unknown }).cookies = { forged: "1" };
      } catch (error) {
        assignment = error;
      }
      return reply.json(req.cookies);
    });

    expect(await (await app.inject({ url: "/x" })).json()).toEqual({});
    await app.inject({ url: "/x" });
    expect(seen[0]).not.toBe(seen[1]);
    expect(assignment).toBeInstanceOf(TypeError);
  });
});

// A reply holds itself in a symbol-keyed slot so that a proxy of it, or an
// object made with Object.create(reply), finds it (see reply.ts). Nothing may
// copy that slot onto another object by accident, and a copy must not make
// that object the reply.
describe("the slot a reply holds itself in", () => {
  const slotOf = (reply: CelsianReply): symbol | undefined =>
    Object.getOwnPropertySymbols(reply).find((key) => key.description === "celsian.reply.self");

  it("is neither enumerable nor writable, so a spread or Object.assign() does not copy it", () => {
    const reply = createReply("http://localhost/");
    const slot = slotOf(reply);
    expect(slot).toBeDefined();
    const descriptor = Object.getOwnPropertyDescriptor(reply, slot as symbol);
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.writable).toBe(false);
    expect(Object.getOwnPropertySymbols({ ...reply })).not.toContain(slot);
    expect(Object.getOwnPropertySymbols(Object.assign({}, reply))).not.toContain(slot);
    // Module code is strict: an assignment to a read-only property throws.
    expect(() => {
      (reply as unknown as Record<symbol, unknown>)[slot as symbol] = createReply("http://localhost/");
    }).toThrow(TypeError);
  });

  it("copied by assignment onto an unrelated object, does not make that object the reply", () => {
    const reply = createReply("http://localhost/");
    const fake = Object.create(Object.getPrototypeOf(reply)) as CelsianReply & Record<symbol, unknown>;
    for (const key of Object.getOwnPropertySymbols(reply))
      fake[key] = (reply as unknown as Record<symbol, unknown>)[key];
    expect(fake.status).toBeUndefined();
    expect(fake.statusCode).toBeUndefined();
    fake.statusCode = 299;
    expect(reply.statusCode).toBe(200);
  });

  it("copied from another request's reply, does not let one request drive the other's answer", async () => {
    const app = createApp({ requestTimeout: 0 });
    let replyA: CelsianReply | undefined;
    let releaseA = () => {};
    const released = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let enteredA = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredA = resolve;
    });
    app.get("/a", async (_request, reply) => {
      replyA = reply;
      enteredA();
      await released;
      return { request: "a" };
    });
    app.get("/b", (_request, reply) => {
      const unrelated = Object.create(Object.getPrototypeOf(reply)) as CelsianReply & Record<symbol, unknown>;
      const slot = slotOf(replyA as CelsianReply);
      if (slot !== undefined) unrelated[slot] = replyA;
      unrelated.status?.(299).header("x-test-marker", "from-b");
      releaseA();
      return { request: "b" };
    });
    const pendingA = app.inject({ url: "/a" });
    await entered;
    const b = await app.inject({ url: "/b" });
    const a = await pendingA;
    expect([a.status, a.headers.get("x-test-marker")]).toEqual([200, null]);
    expect([b.status, b.headers.get("x-test-marker")]).toEqual([200, null]);
  });

  it("pointing at something that is not a reply, is not honoured, and reading through it gives undefined", () => {
    const reply = createReply("http://localhost/");
    const slot = slotOf(reply) as symbol;
    const forged = Object.create(Object.getPrototypeOf(reply)) as CelsianReply;
    // Forged with the descriptor a reply gives its own slot, but holding a plain object.
    Object.defineProperty(forged, slot, { value: {}, writable: false, enumerable: false, configurable: true });
    expect(forged.statusCode).toBeUndefined();
    expect(forged.sent).toBeUndefined();
    expect(forged.json).toBeUndefined();
  });
});
