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
