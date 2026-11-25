// @celsian/core -- request bodies on core's Node server
//
// A body arrives as a Node stream. The Request wraps it in web streams, and the
// body parser used to read it through them. It now reads the Node stream
// itself when nothing else can be reading the same bytes. Everything a route,
// a hook or a client can observe has to be identical: what is parsed, what the
// limit rejects, and what the request says about its body afterwards. Each
// case here goes over a real socket and also holds on the previous reader.

import { Agent, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { type ServeResult, serve } from "../src/serve.js";

let server: ServeResult | undefined;
let port = 0;

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function listen(app: CelsianApp): Promise<string> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  server = await serve(app, {
    port: 0,
    host: "127.0.0.1",
    handleFatalErrors: false,
    shutdownTimeout: 200,
    onReady: (info) => {
      port = info.port;
    },
  });
  return `http://127.0.0.1:${port}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const JSON_HEADERS = { "content-type": "application/json" };

/** Write raw bytes to the server in the given pieces, with a pause between them, and return the raw response. */
function rawExchange(pieces: (string | Buffer)[], pauseMs = 15): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(received).toString("utf8")));
    socket.on("connect", async () => {
      for (const piece of pieces) {
        socket.write(piece);
        await sleep(pauseMs);
      }
    });
  });
}

/** The status code and the body (which follows the blank line) of a raw response. */
function parseRaw(raw: string): { status: number; body: string } {
  const [head = "", ...rest] = raw.split("\r\n\r\n");
  return { status: Number(head.split(" ")[1]), body: rest.join("\r\n\r\n") };
}

describe("bodies parsed by core's Node server", () => {
  it("parses JSON, text, urlencoded and multipart bodies", async () => {
    const app = createApp();
    app.post("/json", (req, reply) => reply.json({ got: req.parsedBody }));
    app.post("/text", (req, reply) => reply.json({ got: req.parsedBody }));
    app.post("/form", (req, reply) => {
      const form = req.parsedBody as FormData;
      return reply.json({ isFormData: form instanceof FormData, entries: [...form.entries()] });
    });
    const base = await listen(app);

    const post = async (path: string, init: RequestInit) =>
      (await fetch(`${base}${path}`, { method: "POST", ...init })).json();

    expect(
      await post("/json", { headers: JSON_HEADERS, body: JSON.stringify({ a: 1, nested: { b: [1, 2] } }) }),
    ).toEqual({
      got: { a: 1, nested: { b: [1, 2] } },
    });
    expect(await post("/text", { headers: { "content-type": "text/plain" }, body: "plain text é☃" })).toEqual({
      got: "plain text é☃",
    });
    expect(await post("/form", { body: new URLSearchParams({ a: "1", b: "two words" }) })).toEqual({
      isFormData: true,
      entries: [
        ["a", "1"],
        ["b", "two words"],
      ],
    });
    const multipart = new FormData();
    multipart.set("name", "Ada");
    multipart.set("note", "line one\nline two");
    expect(await post("/form", { body: multipart })).toEqual({
      isFormData: true,
      entries: [
        ["name", "Ada"],
        ["note", "line one\r\nline two"],
      ],
    });
  });

  it("strips prototype-polluting keys from JSON, as before", async () => {
    const app = createApp();
    app.post("/json", (req, reply) => reply.json({ keys: Object.keys(req.parsedBody as object) }));
    const base = await listen(app);

    const res = await fetch(`${base}/json`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: '{"ok":1,"__proto__":{"polluted":true},"constructor":{"x":1}}',
    });
    expect(await res.json()).toEqual({ keys: ["ok"] });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("reassembles a large body that arrives in many chunks", async () => {
    const app = createApp();
    app.post("/json", (req, reply) => {
      const body = req.parsedBody as { items: string[] };
      return reply.json({ count: body.items.length, last: body.items.at(-1) });
    });
    const base = await listen(app);

    const items = Array.from({ length: 20_000 }, (_, i) => `item-${i}-éè☃`);
    const res = await fetch(`${base}/json`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ items }) });
    expect(await res.json()).toEqual({ count: 20_000, last: "item-19999-éè☃" });
  });

  it("decodes a multi-byte character split across two chunks, and ignores a byte order mark", async () => {
    const app = createApp();
    app.post("/json", (req, reply) => reply.json({ got: req.parsedBody }));
    await listen(app);

    // "☃" is three bytes in UTF-8; the split falls after the first of them.
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"snow":"☃ man"}')]);
    const cut = body.indexOf(0xe2) + 1;
    const head = `POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    const raw = await rawExchange([head, body.subarray(0, cut), body.subarray(cut)]);

    expect(parseRaw(raw).status).toBe(200);
    expect(JSON.parse(parseRaw(raw).body)).toEqual({ got: { snow: "☃ man" } });
  });

  it("reads a chunked upload with no Content-Length", async () => {
    const app = createApp();
    app.post("/json", (req, reply) => reply.json({ got: req.parsedBody }));
    await listen(app);

    const chunk = (text: string) => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
    const raw = await rawExchange([
      "POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
      chunk('{"a":'),
      chunk('"first",'),
      chunk('"b":"second"}'),
      "0\r\n\r\n",
    ]);

    const { status, body } = parseRaw(raw);
    expect(status).toBe(200);
    expect(body).toContain('{"got":{"a":"first","b":"second"}}');
  });

  it("leaves parsedBody undefined for an empty or blank body", async () => {
    const app = createApp();
    app.post("/json", (req, reply) =>
      reply.json({ parsed: req.parsedBody === undefined ? "undefined" : req.parsedBody }),
    );
    const base = await listen(app);

    for (const body of ["", "   \n "]) {
      const res = await fetch(`${base}/json`, { method: "POST", headers: JSON_HEADERS, body });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ parsed: "undefined" });
    }
  });

  it("answers 400 INVALID_JSON for malformed JSON, with the parser's message", async () => {
    const app = createApp();
    app.post("/json", (req, reply) => reply.json({ got: req.parsedBody }));
    const base = await listen(app);

    const res = await fetch(`${base}/json`, { method: "POST", headers: JSON_HEADERS, body: '{"a": nope}' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("INVALID_JSON");
    expect(body.error).toMatch(/^Invalid JSON \(content-type: application\/json\): /);
    let expected = "";
    try {
      JSON.parse('{"a": nope}');
    } catch (error) {
      expected = (error as Error).message;
    }
    expect(body.error.endsWith(expected)).toBe(true);
  });

  it("runs a custom content-type parser on the whole body", async () => {
    const app = createApp();
    app.addContentTypeParser("application/x-lines", async (request) => (await request.text()).split("\n"));
    app.post("/lines", (req, reply) => reply.json({ got: req.parsedBody }));
    const base = await listen(app);

    const res = await fetch(`${base}/lines`, {
      method: "POST",
      headers: { "content-type": "application/x-lines" },
      body: "one\ntwo\nthree",
    });
    expect(await res.json()).toEqual({ got: ["one", "two", "three"] });
  });

  it("leaves a body it does not parse for the handler to read", async () => {
    const app = createApp();
    app.post("/bytes", async (req, reply) => {
      const before = req.bodyUsed;
      const bytes = new Uint8Array(await req.arrayBuffer());
      return reply.json({ before, after: req.bodyUsed, bytes: [...bytes], parsed: req.parsedBody ?? null });
    });
    const base = await listen(app);

    const res = await fetch(`${base}/bytes`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3, 250]),
    });
    expect(await res.json()).toEqual({ before: false, after: true, bytes: [1, 2, 3, 250], parsed: null });
  });

  it("serves several bodies in a row on one keep-alive connection", async () => {
    const app = createApp();
    app.post("/json", (req, reply) => reply.json({ got: req.parsedBody }));
    await listen(app);

    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const post = (payload: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = httpRequest(
          {
            port,
            host: "127.0.0.1",
            path: "/json",
            method: "POST",
            agent,
            headers: { ...JSON_HEADERS, "content-length": Buffer.byteLength(body) },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () => resolve(JSON.parse(text)));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    try {
      for (let i = 0; i < 8; i++) expect(await post({ n: i })).toEqual({ got: { n: i } });
    } finally {
      agent.destroy();
    }
  });
});

describe("what a request says about its body after it was parsed", () => {
  it("reports the body as used, and refuses to read or clone it again", async () => {
    const app = createApp();
    app.post("/json", async (req, reply) => {
      const report: Record<string, unknown> = { bodyUsed: req.bodyUsed, parsed: req.parsedBody };
      for (const method of ["text", "json", "arrayBuffer", "blob", "formData"] as const) {
        report[method] = await req[method]().then(
          () => "resolved",
          (error: Error) => `${error.constructor.name}`,
        );
      }
      try {
        req.clone();
        report.clone = "returned";
      } catch (error) {
        report.clone = (error as Error).constructor.name;
      }
      const stream = req.body;
      report.bodyIsStream = stream instanceof ReadableStream;
      report.bodyStillUsed = req.bodyUsed;
      return reply.json(report);
    });
    const base = await listen(app);

    const res = await fetch(`${base}/json`, { method: "POST", headers: JSON_HEADERS, body: '{"a":1}' });
    expect(await res.json()).toEqual({
      bodyUsed: true,
      parsed: { a: 1 },
      text: "TypeError",
      json: "TypeError",
      arrayBuffer: "TypeError",
      blob: "TypeError",
      formData: "TypeError",
      clone: "TypeError",
      bodyIsStream: true,
      bodyStillUsed: true,
    });
  });

  it("gives the same 'already read' error text as reading the body twice does", async () => {
    const app = createApp();
    app.post("/json", async (req, reply) => {
      const afterParse = await req.text().catch((error: Error) => error.message);
      return reply.json({ afterParse });
    });
    app.post("/bytes", async (req, reply) => {
      await req.text();
      const secondRead = await req.text().catch((error: Error) => error.message);
      return reply.json({ secondRead });
    });
    const base = await listen(app);

    const parsed = (await (
      await fetch(`${base}/json`, { method: "POST", headers: JSON_HEADERS, body: "{}" })
    ).json()) as {
      afterParse: string;
    };
    const twice = (await (
      await fetch(`${base}/bytes`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "x",
      })
    ).json()) as { secondRead: string };
    expect(parsed.afterParse).toBe(twice.secondRead);
    expect(parsed.afterParse).toMatch(/unusable|already been read|used/i);
  });
});

describe("hooks that touch the body before it is parsed", () => {
  it("lets a hook read a clone (signature checks) and still parses the body", async () => {
    const app = createApp();
    let raw = "";
    app.addHook("onRequest", async (req) => {
      if (req.method === "POST") raw = await req.clone().text();
    });
    app.post("/json", (req, reply) => reply.json({ raw, parsed: req.parsedBody }));
    const base = await listen(app);

    const res = await fetch(`${base}/json`, { method: "POST", headers: JSON_HEADERS, body: '{"signed":true}' });
    expect(await res.json()).toEqual({ raw: '{"signed":true}', parsed: { signed: true } });
  });

  it("lets a handler read a clone that a hook made but did not read", async () => {
    const app = createApp();
    app.addHook("onRequest", (req) => {
      if (req.method === "POST") (req as Record<string, unknown>).copy = req.clone();
    });
    app.post("/json", async (req, reply) =>
      reply.json({ parsed: req.parsedBody, copy: await (req.copy as Request).text() }),
    );
    const base = await listen(app);

    const res = await fetch(`${base}/json`, { method: "POST", headers: JSON_HEADERS, body: '{"a":1}' });
    expect(await res.json()).toEqual({ parsed: { a: 1 }, copy: '{"a":1}' });
  });

  it("answers 400 when a hook already read the body itself, as it always has", async () => {
    const app = createApp();
    let raw = "";
    app.addHook("preParsing", async (req) => {
      raw = await req.text();
    });
    app.post("/json", (req, reply) => reply.json({ raw, parsed: req.parsedBody ?? null }));
    const base = await listen(app);

    // A body read through the request leaves its stream locked, so the parser
    // cannot read it again. Not a behaviour to keep forever, but not one to
    // change by accident either.
    const res = await fetch(`${base}/json`, { method: "POST", headers: JSON_HEADERS, body: '{"a":1}' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_JSON");
    expect(raw).toBe('{"a":1}');
  });

  it("answers 400 when a hook holds a reader on the body", async () => {
    const app = createApp();
    app.addHook("preParsing", (req) => {
      req.body?.getReader();
    });
    app.post("/json", (req, reply) => reply.json({ parsed: req.parsedBody }));
    const base = await listen(app);

    const res = await fetch(`${base}/json`, { method: "POST", headers: JSON_HEADERS, body: '{"a":1}' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_JSON");
  });
});

// The declared length is checked against the limit before the body is read.
// It is read once, whichever stream the body then comes from, and a failure
// to read it is a failure to read the body: a 400 from the parser, not a 500
// from the lifecycle. On ef8953c that was so on both paths; since c8855c4 the
// Request path (inject(), the other runtimes' adapters) read it twice, and a
// header getter that threw gave a 500 on both paths.
describe.each(["inject", "socket"] as const)("the declared length of a body, through %s", (via) => {
  /** An app whose preParsing hook counts reads of content-length, and makes them throw when `fail` is set. */
  function countingApp(fail: boolean) {
    const app = createApp();
    const counted = { reads: 0 };
    app.addHook("preParsing", (req) => {
      const get = req.headers.get.bind(req.headers);
      // `get` is read-only in the Headers type, not on the object.
      (req.headers as { get: Headers["get"] }).get = (name: string) => {
        if (name.toLowerCase() === "content-length") {
          counted.reads++;
          if (fail) throw new Error("length unavailable");
        }
        return get(name);
      };
    });
    app.post("/", (req, reply) => reply.json({ got: req.parsedBody }));
    return { app, counted };
  }

  async function post(app: CelsianApp, type: string, body: string): Promise<Response> {
    if (via === "inject")
      return app.inject({ method: "POST", url: "/", headers: { "content-type": type }, payload: body });
    const base = await listen(app);
    return fetch(`${base}/`, { method: "POST", headers: { "content-type": type }, body });
  }

  it.each([
    ["application/json", '{"a":1}', { a: 1 }],
    ["text/plain", "hello", "hello"],
  ] as const)("reads it once for %s", async (type, body, parsed) => {
    const { app, counted } = countingApp(false);
    const res = await post(app, type, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: parsed });
    expect(counted.reads).toBe(1);
  });

  it.each([
    ["application/json", "INVALID_JSON", '{"a":1}'],
    ["text/plain", "INVALID_BODY", "hello"],
  ] as const)("answers a %s body whose length cannot be read with a 400 %s", async (type, code, body) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, counted } = countingApp(true);
    const res = await post(app, type, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ statusCode: 400, code });
    expect(counted.reads).toBe(1);
  });
});

describe("the body limit on core's Node server", () => {
  it("rejects a declared length over the limit with 413, without reading, and keeps the connection usable", async () => {
    const app = createApp({ bodyLimit: 64 });
    app.post("/json", (req, reply) => reply.json({ got: req.parsedBody }));
    await listen(app);

    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const post = (body: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            port,
            host: "127.0.0.1",
            path: "/json",
            method: "POST",
            agent,
            headers: { ...JSON_HEADERS, "content-length": Buffer.byteLength(body) },
          },
          (res) => {
            let text = "";
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    try {
      const tooLarge = await post(JSON.stringify({ data: "x".repeat(200) }));
      expect(tooLarge.status).toBe(413);
      expect(JSON.parse(tooLarge.body).error).toContain("exceeds the 64 byte limit (received at least 211 bytes)");
      const fine = await post('{"ok":true}');
      expect(fine.status).toBe(200);
      expect(JSON.parse(fine.body)).toEqual({ got: { ok: true } });
    } finally {
      agent.destroy();
    }
  });

  it("rejects an undeclared (chunked) body with 413 once it passes the limit", async () => {
    const app = createApp({ bodyLimit: 64 });
    app.post("/json", (req, reply) => reply.json({ got: req.parsedBody }));
    app.post("/text", (req, reply) => reply.json({ got: req.parsedBody }));
    app.get("/health", (_req, reply) => reply.json({ ok: true }));
    const base = await listen(app);

    const chunk = (text: string) => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
    for (const [path, type] of [
      ["/json", "application/json"],
      ["/text", "text/plain"],
    ] as const) {
      const raw = await rawExchange([
        `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: ${type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
        chunk('{"data":"'),
        chunk("y".repeat(40)),
        chunk("z".repeat(40)),
        chunk('"}'),
        "0\r\n\r\n",
      ]);
      const { status, body } = parseRaw(raw);
      expect(status, path).toBe(413);
      expect(body, path).toContain("exceeds the 64 byte limit");
    }
    // The server is still serving.
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
  });

  it("accepts a body of exactly the limit", async () => {
    const body = JSON.stringify({ data: "x".repeat(40) });
    const app = createApp({ bodyLimit: Buffer.byteLength(body) });
    app.post("/json", (req, reply) => reply.json({ length: (req.parsedBody as { data: string }).data.length }));
    const base = await listen(app);

    const res = await fetch(`${base}/json`, { method: "POST", headers: JSON_HEADERS, body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: 40 });
  });

  it("applies the limit to multipart bodies and to custom parsers", async () => {
    const app = createApp({ bodyLimit: 64 });
    app.addContentTypeParser("application/x-lines", async (request) => (await request.text()).split("\n"));
    app.post("/any", (req, reply) => reply.json({ got: req.parsedBody }));
    const base = await listen(app);

    const multipart = new FormData();
    multipart.set("note", "n".repeat(200));
    expect((await fetch(`${base}/any`, { method: "POST", body: multipart })).status).toBe(413);
    const lines = await fetch(`${base}/any`, {
      method: "POST",
      headers: { "content-type": "application/x-lines" },
      body: "l".repeat(200),
    });
    expect(lines.status).toBe(413);
  });
});

describe("a client that goes away while its body is being read", () => {
  it("does not take the server down or leave an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const app = createApp();
    let handlerRan = false;
    app.post("/json", (req, reply) => {
      handlerRan = true;
      return reply.json({ got: req.parsedBody });
    });
    app.get("/health", (_req, reply) => reply.json({ ok: true }));
    const base = await listen(app);

    try {
      await new Promise<void>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.on("error", () => {});
        socket.on("close", () => resolve());
        socket.on("connect", async () => {
          // Promise 1000 bytes, send 10, hang up.
          socket.write(
            "POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n",
          );
          socket.write('{"partial"');
          await sleep(40);
          socket.destroy();
        });
      });
      await sleep(60);
      expect(handlerRan).toBe(false);
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
