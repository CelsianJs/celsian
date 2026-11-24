// @celsian/core -- the Node writer must send the headers a Response actually carries
//
// reply.json()/send()/html() and the auto-serializer tag their Response with a
// snapshot of its headers, which the Node writer sends in one writeHead()+end().
// The snapshot was taken when the Response was built. A header added afterwards
// lives only on the Response's own Headers object, which is what inject() and
// every non-Node runtime read. So `res.headers.set("x-late", "1")` showed up in
// tests and was silently dropped by a real Node server.
//
// Every assertion on the wire here goes through a real listening server. The
// inject() result is asserted next to it, because the two disagreeing was the bug.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { getFastPayload } from "../src/fast-response.js";
import { type ServeResult, serve } from "../src/serve.js";

let server: ServeResult | undefined;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

/** Start `app` on a real port and return its base URL. */
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

describe("headers changed after a fast Response was built reach a real Node client", () => {
  it("sends a header added to a reply.json() Response", async () => {
    const app = createApp();
    app.get("/x", (_req, reply) => {
      const res = reply.json({ ok: true });
      res.headers.set("x-late", "1");
      return res;
    });
    const base = await listen(app);

    const viaInject = await app.inject({ url: "/x" });
    const viaNode = await fetch(`${base}/x`);

    expect(viaInject.headers.get("x-late")).toBe("1");
    expect(viaNode.headers.get("x-late")).toBe("1");
    // The rest of the response is intact, and still a single sized write.
    expect(viaNode.status).toBe(200);
    expect(viaNode.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(viaNode.headers.get("content-length")).toBe(String(JSON.stringify({ ok: true }).length));
    expect(viaNode.headers.get("transfer-encoding")).toBeNull();
    expect(await viaNode.json()).toEqual({ ok: true });
  });

  it("sends late headers on every fast response kind: send(), html(), status-only", async () => {
    const app = createApp();
    const late = (res: Response) => {
      res.headers.set("x-late", "1");
      return res;
    };
    app.get("/text", (_req, reply) => late(reply.send("hello")));
    app.get("/html", (_req, reply) => late(reply.html("<p>hi</p>")));
    app.get("/bytes", (_req, reply) => late(reply.send(new Uint8Array([1, 2, 3]))));
    app.get("/empty", (_req, reply) => late(reply.status(204).send(null)));
    const base = await listen(app);

    for (const path of ["/text", "/html", "/bytes", "/empty"]) {
      const viaNode = await fetch(`${base}${path}`);
      await viaNode.arrayBuffer();
      expect(viaNode.headers.get("x-late"), path).toBe("1");
    }
  });

  it("sends a header that was replaced, and drops one that was deleted", async () => {
    const app = createApp();
    app.get("/x", (_req, reply) => {
      const res = reply.header("cache-control", "no-store").send("plain");
      res.headers.set("cache-control", "public, max-age=60");
      // Deleted on the Response itself. (A header set through reply.header()
      // would be put back when the reply is merged in, on every runtime.)
      res.headers.delete("content-type");
      return res;
    });
    const base = await listen(app);

    const viaInject = await app.inject({ url: "/x" });
    const viaNode = await fetch(`${base}/x`);

    for (const res of [viaInject, viaNode]) {
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      expect(res.headers.get("content-type")).toBeNull();
      expect(await res.text()).toBe("plain");
    }
  });

  it("sends a cookie appended late alongside the ones set through the reply", async () => {
    const app = createApp();
    app.get("/x", (_req, reply) => {
      const res = reply.cookie("a", "1").json({ ok: true });
      res.headers.append("set-cookie", "late=2; Path=/");
      return res;
    });
    const base = await listen(app);

    const viaInject = await app.inject({ url: "/x" });
    const viaNode = await fetch(`${base}/x`);
    await viaNode.text();

    expect(viaInject.headers.getSetCookie()).toHaveLength(2);
    expect(viaNode.headers.getSetCookie()).toEqual(viaInject.headers.getSetCookie());
    expect(viaNode.headers.getSetCookie()[1]).toBe("late=2; Path=/");
  });

  it("sends a header added by code wrapping the handler, on an auto-serialized result", async () => {
    // The usual shape of this bug outside a route body: a wrapper around
    // app.handle() (request ids, timing headers) on a custom Node server.
    const app = createApp();
    app.get("/x", () => ({ ok: true }));
    const handle = app.handle.bind(app);
    app.handle = async (request) => {
      const res = await handle(request);
      res.headers.set("x-request-id", "req-7");
      return res;
    };
    const base = await listen(app);

    const viaNode = await fetch(`${base}/x`);

    expect(viaNode.headers.get("x-request-id")).toBe("req-7");
    expect(await viaNode.json()).toEqual({ ok: true });
  });

  it("is unaffected by code that only reads the headers", async () => {
    const app = createApp();
    app.get("/x", (_req, reply) => {
      const res = reply.header("x-early", "yes").cookie("a", "1").json({ ok: true });
      void res.headers.get("content-type");
      return res;
    });
    const base = await listen(app);

    const viaNode = await fetch(`${base}/x`);

    expect(viaNode.headers.get("x-early")).toBe("yes");
    expect(viaNode.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(viaNode.headers.getSetCookie()).toHaveLength(1);
    expect(await viaNode.json()).toEqual({ ok: true });
  });
});

describe("a Response nobody touched still takes the snapshot write", () => {
  // The fast path exists to avoid reading the Headers object per request. These
  // pin that core's own request pipeline does not mark a response as touched,
  // which would quietly move every request onto the slower live-headers write.
  it("leaves the payload unexposed through the whole request pipeline", async () => {
    const app = createApp();
    app.addHook("onSend", (_req, reply) => {
      reply.header("x-from-hook", "1");
    });
    app.get("/json", (_req, reply) => reply.json({ ok: true }));
    app.get("/auto", () => ({ ok: true }));
    app.get("/text", () => "hello");
    app.get("/same", (_req, reply) => reply.header("x-from-hook", "1").json({ ok: true }));

    const plain = createApp();
    plain.get("/with-reply-headers", (_req, reply) => reply.header("x-early", "yes").cookie("a", "1").json({ ok: 1 }));
    plain.get("/auto-with-reply-headers", (_req, reply) => {
      reply.header("x-early", "yes");
      return { ok: true };
    });

    for (const [target, url] of [
      [app, "/same"],
      [plain, "/with-reply-headers"],
      [plain, "/auto-with-reply-headers"],
    ] as const) {
      const res = await target.handle(new Request(`http://localhost${url}`));
      const fast = getFastPayload(res);
      expect(fast, url).toBeDefined();
      expect(fast?.headersExposed, url).toBe(false);
    }

    for (const url of ["/json", "/auto", "/text"]) {
      // onSend added a header the response did not carry, so core rebuilt it:
      // that is a plain Response with no snapshot at all, as before this fix.
      const res = await app.handle(new Request(`http://localhost${url}`));
      expect(getFastPayload(res), url).toBeUndefined();
    }
  });

  it("marks the payload exposed as soon as the headers are read", async () => {
    const app = createApp();
    app.get("/x", () => ({ ok: true }));

    const res = await app.handle(new Request("http://localhost/x"));
    const fast = getFastPayload(res);

    expect(fast?.headersExposed).toBe(false);
    void res.headers;
    expect(fast?.headersExposed).toBe(true);
    expect(res).toBeInstanceOf(Response);
  });

  it("serves an untouched response from the snapshot, byte for byte", async () => {
    const app = createApp();
    app.get("/x", (_req, reply) => reply.header("X-Mixed-Case", "kept").cookie("a", "1").json({ ok: true }));
    const base = await listen(app);

    const viaNode = await fetch(`${base}/x`);

    expect(viaNode.headers.get("x-mixed-case")).toBe("kept");
    expect(viaNode.headers.get("content-length")).toBe("11");
    expect(viaNode.headers.getSetCookie()).toHaveLength(1);
    expect(await viaNode.json()).toEqual({ ok: true });
  });
});
