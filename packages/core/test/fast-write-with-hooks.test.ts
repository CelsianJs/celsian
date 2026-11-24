// @celsian/core -- a fast response keeps its single write when hooks add headers
//
// reply.json()/send()/html() and the auto-serializer tag their Response with the
// already-serialized body, which the Node writer sends in one writeHead()+end().
// A header set on the reply afterwards (cors(), security(), any onSend hook)
// used to be merged by building a second Response around the first one's body
// stream. That copy carried no payload, so every app that registered cors() or
// security() had its responses drained from a stream and sent chunked.
//
// The merged headers are now kept beside the Response as plain data. These
// tests pin two things: the write stays a single sized one on a real socket,
// and the plain-data merge gives exactly the headers the `Headers` merge gives.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { getFastPayload, type Outgoing, toResponse, WireResponse } from "../src/fast-response.js";
import { cors } from "../src/plugins/cors.js";
import { security } from "../src/plugins/security.js";
import { createReply } from "../src/reply.js";
import { mergeReply, mergeReplyIntoResponse } from "../src/response-merge.js";
import { type ServeResult, serve } from "../src/serve.js";
import type { CelsianReply } from "../src/types.js";

let server: ServeResult | undefined;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function listen(app: CelsianApp): Promise<string> {
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

/** A sized, unchunked response: what the single writeHead()+end() produces and a stream drain does not. */
function expectSingleWrite(res: Response, body: string): void {
  expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
  expect(res.headers.get("transfer-encoding")).toBeNull();
}

describe("the Node writer keeps its single write when hooks add headers", () => {
  it("sends cors() and security() headers on a sized, unchunked response", async () => {
    const app = createApp();
    await app.register(cors(), { encapsulate: false });
    await app.register(security(), { encapsulate: false });
    app.get("/json", (_req, reply) => reply.json({ message: "Hello, World!" }));
    app.get("/auto", () => ({ auto: true }));
    app.get("/text", () => "plain");
    app.get("/html", (_req, reply) => reply.html("<p>hi</p>"));
    const base = await listen(app);

    for (const [path, body, type] of [
      ["/json", '{"message":"Hello, World!"}', "application/json; charset=utf-8"],
      ["/auto", '{"auto":true}', "application/json; charset=utf-8"],
      ["/text", "plain", "text/plain; charset=utf-8"],
      ["/html", "<p>hi</p>", "text/html; charset=utf-8"],
    ] as const) {
      const viaNode = await fetch(`${base}${path}`);
      const viaInject = await app.inject({ url: path });

      expect(viaNode.status, path).toBe(200);
      expectSingleWrite(viaNode, body);
      expect(await viaNode.text(), path).toBe(body);
      expect(await viaInject.text(), path).toBe(body);

      for (const res of [viaNode, viaInject]) {
        expect(res.headers.get("content-type"), path).toBe(type);
        expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
        expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
        expect(res.headers.get("x-frame-options"), path).toBe("DENY");
        expect(res.headers.get("strict-transport-security"), path).toBe("max-age=31536000; includeSubDomains");
        expect(res.headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
      }
    }
  });

  it("sends headers and cookies set in onSend, next to the ones the handler set", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, reply) => {
      reply.header("x-from-hook", "1");
      reply.cookie("hook", "h", { secure: false });
    });
    app.get("/x", (_req, reply) =>
      reply.header("x-early", "yes").cookie("early", "e", { secure: false }).json({ a: 1 }),
    );
    const base = await listen(app);

    const viaNode = await fetch(`${base}/x`);
    const viaInject = await app.inject({ url: "/x" });

    expectSingleWrite(viaNode, '{"a":1}');
    for (const res of [viaNode, viaInject]) {
      expect(res.headers.get("x-early")).toBe("yes");
      expect(res.headers.get("x-from-hook")).toBe("1");
      expect(res.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual(["early=e", "hook=h"]);
      expect(await res.json()).toEqual({ a: 1 });
    }
  });

  it("lets an onSend hook replace a header it was shown, and keeps the handler's own otherwise", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, reply) => {
      // Shown `x-shown: handler` and replaces it; never saw content-type, so cannot replace that.
      reply.header("x-shown", "hook");
    });
    app.get("/x", (_req, reply) => reply.header("x-shown", "handler").json({ a: 1 }));
    const base = await listen(app);

    const viaNode = await fetch(`${base}/x`);
    const viaInject = await app.inject({ url: "/x" });

    expectSingleWrite(viaNode, '{"a":1}');
    expect(viaNode.headers.get("x-shown")).toBe("hook");
    expect(viaInject.headers.get("x-shown")).toBe("hook");
  });

  it("keeps the single write for a HEAD-less 204 and for an early-returning hook", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, reply) => {
      reply.header("x-from-hook", "1");
    });
    app.get("/empty", (_req, reply) => reply.status(204).send(null));
    app.route({
      method: "GET",
      url: "/early",
      onRequest: [(_req, reply) => reply.header("x-early", "yes").status(401).json({ error: "no" })],
      handler: () => ({ never: true }),
    });
    const base = await listen(app);

    const empty = await fetch(`${base}/empty`);
    expect(empty.status).toBe(204);
    expect(empty.headers.get("x-from-hook")).toBe("1");

    const early = await fetch(`${base}/early`);
    expect(early.status).toBe(401);
    expect(early.headers.get("x-early")).toBe("yes");
    expectSingleWrite(early, '{"error":"no"}');
    expect(await early.json()).toEqual({ error: "no" });
  });

  it("answers HEAD with the merged headers and no body", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
    app.get("/x", (_req, reply) => reply.cookie("a", "1", { secure: false }).json({ a: 1 }));
    const base = await listen(app);

    for (const res of [await fetch(`${base}/x`, { method: "HEAD" }), await app.inject({ method: "HEAD", url: "/x" })]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(res.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual(["a=1"]);
      expect(await res.text()).toBe("");
    }
  });

  it("never modifies the Response the handler built", async () => {
    const app = createApp();
    let n = 0;
    app.addHook("onSend", (_req, reply) => {
      reply.header("x-request", String(++n));
    });
    let built: Response | undefined;
    app.get("/x", (_req, reply) => {
      built = reply.json({ ok: true });
      return built;
    });
    const base = await listen(app);

    const first = await fetch(`${base}/x`);
    const firstBuilt = built;
    const second = await fetch(`${base}/x`);

    expect(first.headers.get("x-request")).toBe("1");
    expect(second.headers.get("x-request")).toBe("2");
    // The handler's own Response still has only what the handler put on it.
    const payload = getFastPayload(firstBuilt as Response);
    expect(payload?.headers).toEqual({ "content-type": "application/json; charset=utf-8" });
    expect(payload?.headersExposed).toBe(false);
    expect((firstBuilt as Response).headers.get("x-request")).toBeNull();
  });

  it("still goes through app.handle when it has been replaced on the instance", async () => {
    const app = createApp();
    app.get("/x", (_req, reply) => reply.json({ ok: true }));
    const original = app.handle.bind(app);
    app.handle = async (request) => {
      const res = await original(request);
      res.headers.set("x-wrapped", "1");
      return res;
    };
    const base = await listen(app);

    const res = await fetch(`${base}/x`);
    expect(res.headers.get("x-wrapped")).toBe("1");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("handle() returns a real Response that still carries a fast payload", async () => {
    const app = createApp();
    await app.register(security(), { encapsulate: false });
    app.get("/x", (_req, reply) => reply.json({ ok: true }));

    const res = await app.handle(new Request("http://localhost/x"));
    expect(res).toBeInstanceOf(Response);
    const payload = getFastPayload(res);
    expect(payload?.body).toBe('{"ok":true}');
    expect(payload?.headers["x-frame-options"]).toBe("DENY");
    expect(payload?.headersExposed).toBe(false);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ─── Parity: the plain-record merge against the Headers merge ───

interface Scenario {
  name: string;
  /** Runs before the response is built. */
  before?: (reply: CelsianReply) => void;
  /** Builds the response (default: reply.json). */
  build?: (reply: CelsianReply) => Response;
  /** Runs after the response is built, before the first merge. */
  after?: (reply: CelsianReply) => void;
  /** Runs as the onSend chain, between the two merges. */
  onSend?: (reply: CelsianReply) => void;
}

interface Outcome {
  status: number;
  headers: [string, string][];
  cookies: string[];
  body: string;
}

type Merge = (out: Outgoing, reply: CelsianReply, shown: Record<string, string> | null) => Outgoing;

/** The request pipeline's two merges, with `merge` doing each one. */
async function run(scenario: Scenario, merge: Merge): Promise<Outcome | { threw: string }> {
  const reply = createReply("http://localhost/");
  scenario.before?.(reply);
  const built = (scenario.build ?? ((r) => r.json({ a: 1 })))(reply);
  scenario.after?.(reply);
  try {
    let out = merge(built, reply, null);
    if (scenario.onSend) {
      const shown = { ...reply.headers };
      scenario.onSend(reply);
      out = merge(out, reply, shown);
    }
    const res = toResponse(out);
    return {
      status: res.status,
      headers: [...res.headers.entries()].filter(([key]) => key !== "set-cookie"),
      cookies: res.headers.getSetCookie(),
      body: await res.text(),
    };
  } catch (error) {
    return { threw: (error as Error).constructor.name };
  }
}

/** The merge as it was before the plain-record path existed. */
const viaHeaders: Merge = (out, reply, shown) => mergeReplyIntoResponse(toResponse(out), reply, shown);

const SCENARIOS: Scenario[] = [
  { name: "nothing to merge" },
  { name: "a header set before the response was built", before: (r) => r.header("x-a", "1") },
  { name: "a header set after the response was built", after: (r) => r.header("x-a", "1") },
  { name: "a header set in onSend", onSend: (r) => r.header("x-a", "1") },
  {
    name: "the security() set in onSend",
    onSend: (r) => {
      r.header("x-content-type-options", "nosniff");
      r.header("x-frame-options", "DENY");
      r.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    },
  },
  {
    name: "a conflicting header set after the response keeps the response's value",
    before: (r) => r.header("x-a", "response"),
    after: (r) => r.header("x-a", "later"),
  },
  {
    name: "onSend replaces a value it was shown",
    before: (r) => r.header("x-a", "shown"),
    onSend: (r) => r.header("x-a", "replaced"),
  },
  {
    name: "onSend cannot replace a value it was not shown",
    onSend: (r) => r.header("content-type", "text/plain"),
  },
  {
    name: "onSend replaces content-type it was shown",
    before: (r) => r.header("content-type", "application/vnd.api+json"),
    onSend: (r) => r.header("content-type", "text/plain"),
  },
  {
    name: "vary values are united",
    before: (r) => r.header("vary", "Accept-Encoding"),
    onSend: (r) => r.header("vary", "Accept-Encoding, Origin"),
  },
  {
    name: "vary added after the response, then extended in onSend",
    before: (r) => r.header("vary", "Accept"),
    after: (r) => r.header("vary", "Cookie"),
    onSend: (r) => r.header("vary", "Origin"),
  },
  { name: "a wildcard vary wins", before: (r) => r.header("vary", "Accept"), onSend: (r) => r.header("vary", "*") },
  { name: "a wildcard vary is kept", before: (r) => r.header("vary", "*"), onSend: (r) => r.header("vary", "Origin") },
  { name: "a cookie queued before the response", before: (r) => r.cookie("a", "1") },
  { name: "a cookie queued after the response", after: (r) => r.cookie("a", "1") },
  { name: "a cookie queued in onSend", onSend: (r) => r.cookie("a", "1") },
  {
    name: "cookies queued at every stage",
    before: (r) => r.cookie("a", "1"),
    after: (r) => r.cookie("b", "2"),
    onSend: (r) => r.cookie("c", "3"),
  },
  {
    name: "a cookie queued twice is sent once",
    before: (r) => r.cookie("a", "1"),
    onSend: (r) => r.cookie("a", "1"),
  },
  {
    name: "a set-cookie header next to queued cookies",
    before: (r) => r.header("set-cookie", "raw=1").cookie("a", "1"),
    onSend: (r) => r.cookie("b", "2"),
  },
  {
    name: "a set-cookie header set in onSend",
    before: (r) => r.cookie("a", "1"),
    onSend: (r) => r.header("set-cookie", "raw=1"),
  },
  {
    name: "a set-cookie header replaced in onSend",
    before: (r) => r.header("set-cookie", "raw=1"),
    onSend: (r) => r.header("set-cookie", "raw=2"),
  },
  {
    name: "headers and cookies together in onSend",
    before: (r) => r.header("x-early", "yes").cookie("a", "1"),
    onSend: (r) => r.header("x-late", "1").cookie("b", "2"),
  },
  {
    name: "a header name with capitals written straight onto reply.headers",
    before: (r) => {
      r.headers["X-Mixed"] = "response";
    },
    onSend: (r) => r.header("x-mixed", "hook"),
  },
  {
    name: "capitals on reply.headers, set after the response",
    after: (r) => {
      r.headers["X-Mixed"] = "later";
    },
  },
  { name: "a value with surrounding whitespace", onSend: (r) => r.header("x-a", "  padded  ") },
  {
    name: "a padded value the response already carries, replaced in onSend",
    before: (r) => r.header("x-a", " padded "),
    onSend: (r) => r.header("x-a", "replaced"),
  },
  { name: "an empty value", onSend: (r) => r.header("x-a", "") },
  { name: "a latin-1 value", onSend: (r) => r.header("x-a", "café") },
  { name: "a value outside latin-1", onSend: (r) => r.header("x-a", "snow ☃") },
  { name: "a value with a control character", onSend: (r) => r.header("x-a", "a\u0001b") },
  { name: "a value with a NUL", onSend: (r) => r.header("x-a", "a\u0000b") },
  { name: "a name that is not a token", onSend: (r) => r.header("x a", "1") },
  { name: "an empty name", onSend: (r) => r.header("", "1") },
  { name: "a name Object.prototype also has", onSend: (r) => r.header("constructor", "1") },
  {
    name: "a name Object.prototype also has, set at both stages",
    before: (r) => r.header("tostring", "a").header("valueof", "b"),
    onSend: (r) => r.header("tostring", "c").header("hasownproperty", "d"),
  },
  { name: "a non-string value on reply.headers", onSend: (r) => Object.assign(r.headers, { "x-n": 5 }) },
  { name: "a cookie outside latin-1 written as a header", onSend: (r) => r.header("set-cookie", "a=☃") },
  { name: "a text response", build: (r) => r.send("hello"), onSend: (r) => r.header("x-a", "1") },
  { name: "a bytes response", build: (r) => r.send(new Uint8Array([104, 105])), onSend: (r) => r.header("x-a", "1") },
  { name: "an html response", build: (r) => r.html("<p>hi</p>"), onSend: (r) => r.cookie("a", "1") },
  { name: "an empty 204", build: (r) => r.status(204).send(null), onSend: (r) => r.header("x-a", "1") },
  {
    name: "a status set on the reply",
    build: (r) => r.status(201).json({ made: true }),
    after: (r) => r.header("location", "/things/1"),
  },
  // The response's own record carries a capitalised Set-Cookie, and only a
  // cookie is merged, so no other header triggers the lower-case check.
  {
    name: "a capitalised Set-Cookie on the response, then only a cookie queued in onSend",
    before: (r) => {
      r.headers["Set-Cookie"] = "raw=1";
    },
    onSend: (r) => r.cookie("a", "1"),
  },
  {
    name: "a capitalised header on the response, then only a cookie queued after it",
    before: (r) => {
      r.headers["X-Mixed"] = "response";
    },
    after: (r) => r.cookie("a", "1"),
    onSend: (r) => r.cookie("b", "2"),
  },
  // The second merge starts from a response that already gained headers, and
  // then meets something only the Headers merge can be trusted with.
  {
    name: "a header added after the response, then a padded value in onSend",
    after: (r) => r.header("x-a", "1"),
    onSend: (r) => r.header("x-b", "  padded  "),
  },
  {
    name: "a header added after the response, then a capitalised name in onSend",
    after: (r) => r.header("x-a", "1"),
    onSend: (r) => {
      r.headers["X-Late"] = "2";
    },
  },
  {
    name: "a cookie added after the response, then a padded Set-Cookie header in onSend",
    after: (r) => r.cookie("a", "1"),
    onSend: (r) => r.header("set-cookie", "  padded=1  "),
  },
  { name: "a padded Set-Cookie header", onSend: (r) => r.header("set-cookie", "  padded=1  ") },
  {
    name: "a padded Set-Cookie carried by the response's record, then a cookie queued in onSend",
    before: (r) => r.header("set-cookie", "  padded=1  "),
    after: (r) => {
      delete r.headers["set-cookie"];
      r.header("x-a", "1");
    },
    onSend: (r) => r.cookie("b", "2"),
  },
  {
    name: "an own __proto__ header, replaced in onSend",
    before: (r) => Object.defineProperty(r.headers, "__proto__", { value: "a", enumerable: true, writable: true }),
    onSend: (r) => Object.defineProperty(r.headers, "__proto__", { value: "b", enumerable: true, writable: true }),
  },
  {
    name: "an own __proto__ header set in onSend",
    onSend: (r) => Object.defineProperty(r.headers, "__proto__", { value: "b", enumerable: true, writable: true }),
  },
];

describe("merging reply headers onto a fast response gives what the Headers merge gives", () => {
  it.each(SCENARIOS)("$name", async (scenario) => {
    const plain = await run(scenario, mergeReply);
    const expected = await run(scenario, viaHeaders);
    expect(plain).toEqual(expected);
  });

  it("uses the plain record for the ordinary cases, and falls back for the ones it cannot trust", () => {
    const merged = (prepare: (reply: CelsianReply) => void, onSend: (reply: CelsianReply) => void): Outgoing => {
      const reply = createReply("http://localhost/");
      prepare(reply);
      const built = reply.json({ a: 1 });
      const shown = { ...reply.headers };
      onSend(reply);
      return mergeReply(built, reply, shown);
    };

    expect(
      merged(
        () => {},
        (r) => r.header("x-a", "1"),
      ),
    ).toBeInstanceOf(WireResponse);
    expect(
      merged(
        () => {},
        (r) => r.cookie("a", "1"),
      ),
    ).toBeInstanceOf(WireResponse);
    // Nothing to add: the very same Response comes back.
    const reply = createReply("http://localhost/");
    const untouched = reply.header("x-a", "1").json({ a: 1 });
    expect(mergeReply(untouched, reply, null)).toBe(untouched);

    // A value Headers would trim, and a name with capitals already on the response.
    expect(
      merged(
        () => {},
        (r) => r.header("x-a", " padded "),
      ),
    ).not.toBeInstanceOf(WireResponse);
    expect(
      merged(
        (r) => {
          r.headers["X-Mixed"] = "1";
        },
        (r) => r.header("x-b", "2"),
      ),
    ).not.toBeInstanceOf(WireResponse);
  });

  // The parity cases above cannot see these: a name or value `Headers` refuses
  // makes BOTH merges end in a TypeError, one while merging and the other only
  // when the result is turned into a Response. What matters is where. The
  // plain-record merge must refuse it itself, at merge time, inside the
  // request lifecycle, where the error path answers it. Kept, it would reach
  // the Node writer as plain data and fail in writeHead(), after the lifecycle.
  it("refuses a name or value Headers would refuse at merge time, not at write time", () => {
    const merge = (onSend: (reply: CelsianReply) => void, after?: (reply: CelsianReply) => void) => {
      const reply = createReply("http://localhost/");
      let out: Outgoing = reply.json({ a: 1 });
      if (after) {
        after(reply);
        out = mergeReply(out, reply, null);
      }
      const shown = { ...reply.headers };
      onSend(reply);
      return mergeReply(out, reply, shown);
    };

    for (const name of ["x a", "", "x-caf\u00e9", "x:y", "x\ty"]) {
      expect(() => merge((r) => r.header(name, "1")), JSON.stringify(name)).toThrow(TypeError);
      // And from a response that had already gained a header.
      expect(
        () =>
          merge(
            (r) => r.header(name, "1"),
            (r) => r.header("x-first", "1"),
          ),
        JSON.stringify(name),
      ).toThrow(TypeError);
    }
    for (const cookie of ["a=\u2603", "a=\u0000"]) {
      expect(() => merge((r) => r.header("set-cookie", cookie)), JSON.stringify(cookie)).toThrow(TypeError);
      expect(
        () =>
          merge(
            (r) => r.header("set-cookie", cookie),
            (r) => r.header("x-first", "1"),
          ),
        JSON.stringify(cookie),
      ).toThrow(TypeError);
    }
  });

  // And these it cannot see because `Headers` trims as it stores, so turning
  // the result into a Response hides the difference. The Node writer sends a
  // WireResponse's record as it stands, padding included.
  it("falls back for a padded Set-Cookie, so the Node writer never sends the padding", () => {
    // Set in onSend.
    const reply = createReply("http://localhost/");
    const built = reply.json({ a: 1 });
    reply.header("set-cookie", "  padded=1  ");
    const merged = mergeReply(built, reply, null);
    expect(merged).not.toBeInstanceOf(WireResponse);
    expect(toResponse(merged).headers.getSetCookie()).toEqual(["padded=1"]);

    // Carried by a response that already gained a header, when a cookie is queued.
    const second = createReply("http://localhost/");
    second.header("set-cookie", "  padded=1  ");
    const response = second.json({ a: 1 });
    delete second.headers["set-cookie"];
    second.header("x-a", "1");
    const first = mergeReply(response, second, null);
    expect(first).toBeInstanceOf(WireResponse);
    expect((first as WireResponse).headers["set-cookie"]).toBe("  padded=1  ");
    second.cookie("b", "2", { secure: false });
    const final = mergeReply(first, second, { ...second.headers });
    expect(final).not.toBeInstanceOf(WireResponse);
    expect(
      toResponse(final)
        .headers.getSetCookie()
        .map((c) => c.split(";")[0]),
    ).toEqual(["padded=1", "b=2"]);
  });

  it("merges through Headers, rather than not at all, when a response that already gained headers needs it", () => {
    const reply = createReply("http://localhost/");
    const built = reply.json({ a: 1 });
    reply.header("x-first", "1");
    const first = mergeReply(built, reply, null);
    expect(first).toBeInstanceOf(WireResponse);

    const shown = { ...reply.headers };
    reply.header("x-padded", "  2  ");
    const second = mergeReply(first, reply, shown);
    // Not the WireResponse handed in, and not another one.
    expect(second).not.toBe(first);
    expect(second).not.toBeInstanceOf(WireResponse);
    const res = toResponse(second);
    expect(res.headers.get("x-first")).toBe("1");
    expect(res.headers.get("x-padded")).toBe("2");
  });

  it("does not use the plain record once the Response's headers have been handed out", () => {
    const reply = createReply("http://localhost/");
    const built = reply.json({ a: 1 });
    built.headers.set("x-live", "1");
    reply.header("x-a", "1");

    const out = mergeReply(built, reply, null);
    expect(out).not.toBeInstanceOf(WireResponse);
    const res = toResponse(out);
    expect(res.headers.get("x-live")).toBe("1");
    expect(res.headers.get("x-a")).toBe("1");
  });
});
