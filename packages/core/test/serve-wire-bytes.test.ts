// @celsian/core -- the bytes core's Node server puts on the wire for a fast response
//
// The single-write path hands Node the header block and the body together.
// Two things about that are easy to get wrong and invisible to inject(), which
// never touches a socket, so they are pinned here against raw bytes.

import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { type ServeResult, serve } from "../src/serve.js";

let server: ServeResult | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function listen(app: CelsianApp): Promise<number> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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

interface Raw {
  status: number;
  /** The header block, one byte per character. */
  head: string;
  body: Buffer;
  /** The bytes of one header's value, as hex. */
  hex(name: string): string | undefined;
  header(name: string): string | undefined;
}

/** One request over its own connection, answered as raw bytes. */
function raw(port: number, path: string, method = "GET"): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.write(`${method} ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      const head = all.subarray(0, split).toString("latin1");
      const lines = head.split("\r\n").slice(1);
      const find = (name: string) =>
        lines.find((line) => line.toLowerCase().startsWith(`${name}: `))?.slice(name.length + 2);
      resolve({
        status: Number(head.slice(9, 12)),
        head,
        body: all.subarray(split + 4),
        header: find,
        hex: (name) => {
          const value = find(name);
          return value === undefined ? undefined : Buffer.from(value, "latin1").toString("hex");
        },
      });
    });
  });
}

// A header value is a byte string. "café" is 63 61 66 E9; as UTF-8 it would be 63 61 66 C3 A9.
const CAFE = "café";
const CAFE_BYTES = "636166e9";

describe("a header value outside ASCII on a fast response", () => {
  it("is written as the bytes inject() reports, with or without an onSend hook", async () => {
    for (const withHook of [false, true]) {
      const app = createApp();
      if (withHook) {
        app.addHook("onSend", (_request, reply) => {
          reply.header("x-hook", "1");
        });
      }
      app.get("/latin", (_request, reply) => reply.header("x-name", CAFE).json({ ok: true }));
      const port = await listen(app);

      const wire = await raw(port, "/latin");
      const injected = await app.inject({ url: "/latin" });

      expect(wire.status).toBe(200);
      expect(wire.hex("x-name"), `hook: ${withHook}`).toBe(CAFE_BYTES);
      expect(injected.headers.get("x-name")).toBe(CAFE);
      expect(wire.header("x-name")).toBe(injected.headers.get("x-name"));
      // Still one sized write, not a chunked one.
      expect(wire.header("content-length")).toBe("11");
      expect(wire.header("transfer-encoding")).toBeUndefined();
      expect(wire.body.toString()).toBe('{"ok":true}');
      if (withHook) expect(wire.header("x-hook")).toBe("1");

      await server?.close();
      server = undefined;
    }
  });

  it("leaves a UTF-8 body as UTF-8, with its byte length", async () => {
    const app = createApp();
    app.get("/both", (_request, reply) => reply.header("x-name", CAFE).send(`body ${CAFE} ✓`));
    const port = await listen(app);

    const wire = await raw(port, "/both");
    expect(wire.hex("x-name")).toBe(CAFE_BYTES);
    expect(wire.body.toString("utf8")).toBe(`body ${CAFE} ✓`);
    expect(wire.header("content-length")).toBe(String(Buffer.byteLength(`body ${CAFE} ✓`)));
  });

  it.each([
    [
      "a returned object",
      (app: CelsianApp) => app.get("/x", (_request, reply) => (reply.header("x-name", CAFE), { ok: 1 })),
    ],
    [
      "a returned string",
      (app: CelsianApp) => app.get("/x", (_request, reply) => (reply.header("x-name", CAFE), "text")),
    ],
    [
      "reply.html()",
      (app: CelsianApp) => app.get("/x", (_request, reply) => reply.header("x-name", CAFE).html("<p>hi</p>")),
    ],
    [
      "a header set by an onSend hook",
      (app: CelsianApp) => {
        app.addHook("onSend", (_request, reply) => {
          reply.header("x-name", CAFE);
        });
        app.get("/x", (_request, reply) => reply.json({ ok: 1 }));
      },
    ],
    [
      "a header added to the Response after it was built",
      (app: CelsianApp) =>
        app.get("/x", (_request, reply) => {
          const response = reply.json({ ok: 1 });
          response.headers.set("x-name", CAFE);
          return response;
        }),
    ],
    [
      "a thrown error answered by the built-in handler, with a hook header",
      (app: CelsianApp) => {
        app.addHook("onSend", (_request, reply) => {
          reply.header("x-name", CAFE);
        });
        app.get("/x", () => {
          throw new Error("boom");
        });
      },
    ],
  ])("is written byte for byte for %s", async (_label, register) => {
    const app = createApp();
    register(app);
    const port = await listen(app);

    const wire = await raw(port, "/x");
    expect(wire.hex("x-name")).toBe(CAFE_BYTES);
    expect(wire.header("transfer-encoding")).toBeUndefined();
    expect(wire.header("content-length")).toBe(String(wire.body.byteLength));
    expect((await app.inject({ url: "/x" })).headers.get("x-name")).toBe(CAFE);
  });

  it("is written byte for byte on the built-in 404 and 405", async () => {
    const app = createApp();
    app.addHook("onSend", (_request, reply) => {
      reply.header("x-name", CAFE);
    });
    app.post("/only-post", (_request, reply) => reply.json({ ok: 1 }));
    const port = await listen(app);

    const missing = await raw(port, "/nope");
    expect(missing.status).toBe(404);
    expect(missing.hex("x-name")).toBe(CAFE_BYTES);
    expect(JSON.parse(missing.body.toString())).toMatchObject({ statusCode: 404 });

    const wrongMethod = await raw(port, "/only-post");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.hex("x-name")).toBe(CAFE_BYTES);
    expect(wrongMethod.header("allow")).toBe("POST");
  });

  it("is written byte for byte in a Set-Cookie value, set as a header or beside reply.cookie()", async () => {
    const app = createApp();
    app.get("/header", (_request, reply) => reply.header("set-cookie", `name=${CAFE}`).json({ ok: 1 }));
    app.get("/both", (_request, reply) =>
      reply.header("set-cookie", `name=${CAFE}`).cookie("b", "2", { secure: false }).json({ ok: 1 }),
    );
    const port = await listen(app);

    const single = await raw(port, "/header");
    expect(single.hex("set-cookie")).toBe(Buffer.from(`name=${CAFE}`, "latin1").toString("hex"));

    const both = await raw(port, "/both");
    const cookies = both.head.split("\r\n").filter((line) => line.toLowerCase().startsWith("set-cookie: "));
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe(`set-cookie: name=${CAFE}`);
    expect(cookies[1]?.startsWith("set-cookie: b=2")).toBe(true);
  });

  it("does not touch an all-ASCII response", async () => {
    const app = createApp();
    app.get("/ascii", (_request, reply) => reply.header("x-name", "cafe").json({ word: CAFE }));
    const port = await listen(app);

    const wire = await raw(port, "/ascii");
    expect(wire.header("x-name")).toBe("cafe");
    expect(wire.body.toString("utf8")).toBe(`{"word":"${CAFE}"}`);
    expect(wire.header("content-length")).toBe(String(Buffer.byteLength(`{"word":"${CAFE}"}`)));
  });
});

// A fast response can have no body at all: reply.send(null), reply.send()
// under a 204. The writer used to fix the header block with writeHead() before
// Node knew the response was empty, so a 200 went out chunked, with a
// zero-length chunk for a body.
describe("a fast response with no body", () => {
  const empty = (app: CelsianApp) => {
    app.get("/empty", (_request, reply) => reply.status(200).send(null));
    app.get("/created", (_request, reply) => reply.status(201).header("location", "/things/1").send(undefined));
    app.get("/no-content", (_request, reply) => reply.status(204).send(null));
    app.get("/not-modified", (_request, reply) => reply.status(304).header("etag", '"v1"').send("ignored"));
    app.get("/cookie", (_request, reply) => reply.cookie("a", "1", { secure: false }).send(null));
  };

  it.each([
    ["no hook", false],
    ["an onSend hook that adds a header", true],
  ])("is sent with Content-Length: 0 and not chunked, with %s", async (_label, withHook) => {
    const app = createApp();
    if (withHook) {
      app.addHook("onSend", (_request, reply) => {
        reply.header("x-hook", "1");
      });
    }
    empty(app);
    const port = await listen(app);

    for (const [path, status] of [
      ["/empty", 200],
      ["/created", 201],
      ["/cookie", 200],
    ] as const) {
      const wire = await raw(port, path);
      expect(wire.status, path).toBe(status);
      expect(wire.header("content-length"), path).toBe("0");
      expect(wire.header("transfer-encoding"), path).toBeUndefined();
      expect(wire.body.byteLength, path).toBe(0);
      if (withHook) expect(wire.header("x-hook"), path).toBe("1");
    }
    expect((await raw(port, "/created")).header("location")).toBe("/things/1");
    expect((await raw(port, "/cookie")).header("set-cookie")?.startsWith("a=1")).toBe(true);
  });

  it.each([
    ["no hook", false],
    ["an onSend hook that adds a header", true],
  ])("is sent with no length and no body under 204 and 304, with %s", async (_label, withHook) => {
    const app = createApp();
    if (withHook) {
      app.addHook("onSend", (_request, reply) => {
        reply.header("x-hook", "1");
      });
    }
    empty(app);
    const port = await listen(app);

    for (const [path, status] of [
      ["/no-content", 204],
      ["/not-modified", 304],
    ] as const) {
      const wire = await raw(port, path);
      expect(wire.status, path).toBe(status);
      expect(wire.header("content-length"), path).toBeUndefined();
      expect(wire.header("transfer-encoding"), path).toBeUndefined();
      expect(wire.body.byteLength, path).toBe(0);
      if (withHook) expect(wire.header("x-hook"), path).toBe("1");
    }
    expect((await raw(port, "/not-modified")).header("etag")).toBe('"v1"');
  });

  it("leaves a keep-alive connection usable for the next request", async () => {
    const app = createApp();
    app.addHook("onSend", (_request, reply) => {
      reply.header("x-hook", "1");
    });
    empty(app);
    app.get("/after", (_request, reply) => reply.json({ after: true }));
    const port = await listen(app);

    // Two requests written back to back on one connection.
    const answer = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.write(
          "GET /empty HTTP/1.1\r\nHost: x\r\n\r\nGET /after HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        );
      });
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    });
    const statuses = [...answer.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => match[1]);
    expect(statuses).toEqual(["200", "200"]);
    expect(answer.endsWith('{"after":true}')).toBe(true);
    expect(answer).not.toContain("chunked");
  });
});
