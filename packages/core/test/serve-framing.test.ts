// @celsian/core -- how core's Node server frames a response whose reply set a framing header
//
// The fast writer sends an already-serialized body in one writeHead()+end()
// and works out the framing itself. A Transfer-Encoding, a Content-Length, a
// Connection or an Upgrade header set on the reply, and a status or a HEAD
// request that allows no body, all bear on that framing. Each case here goes
// through Node's own HTTP client, which refuses a response whose framing
// contradicts itself, over a keep-alive connection, and is followed by a
// second request: if the first answer left the connection out of step, the
// second one shows it.

import http from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { type ServeResult, serve } from "../src/serve.js";
import type { CelsianReply } from "../src/types.js";

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

interface Answer {
  status: number;
  body: string;
  /** Every header as it was sent, by lower-cased name. */
  headers: Map<string, string[]>;
  /** Whether the request went out on a connection an earlier request had used. */
  reused: boolean;
  /** Whether Node's client took the response for a protocol upgrade. */
  upgraded: boolean;
}

/** One request through Node's own HTTP client. Rejects with the client's parse error, if any. */
function request(port: number, method: string, path: string, agent: http.Agent): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const headers = new Map<string, string[]>();
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const name = (res.rawHeaders[i] as string).toLowerCase();
          headers.set(name, [...(headers.get(name) ?? []), res.rawHeaders[i + 1] as string]);
        }
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("latin1"),
          headers,
          reused: req.reusedSocket,
          upgraded: false,
        });
      });
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, body: "", headers: new Map(), reused: req.reusedSocket, upgraded: true });
    });
    req.setTimeout(3000, () => req.destroy(new Error(`no complete answer to ${method} ${path} within 3 s`)));
    req.on("error", reject);
    req.end();
  });
}

/** `method path`, then `GET /after` through the same single keep-alive connection when it is still open. */
async function exchange(port: number, method: string, path: string): Promise<{ first: Answer; next: Answer }> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const first = await request(port, method, path, agent);
    const next = await request(port, "GET", "/after", agent);
    return { first, next };
  } finally {
    agent.destroy();
  }
}

const one = (answer: Answer, name: string) => answer.headers.get(name);

/**
 * `method path` and `GET /after` written back to back on one socket, as raw
 * bytes: the first answer's header block, and everything after it. For the
 * answers after which Node's client does not reuse a connection although
 * their framing is complete (a HEAD answer with no length; ef8953c's is not
 * reused either), so the connection is checked on the bytes: the GET's status
 * line must follow at once.
 */
async function pipelined(port: number, method: string, path: string): Promise<{ head: string; rest: string }> {
  const wire = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: x\r\n\r\nGET /after HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
  });
  const end = wire.indexOf("\r\n\r\n");
  return { head: wire.slice(0, end).toLowerCase(), rest: wire.slice(end + 4) };
}

/** Routes that set framing headers on the reply, as an application would. */
function routes(app: CelsianApp, withHook: boolean): void {
  if (withHook) {
    app.addHook("onSend", (_request, reply) => {
      reply.header("x-hook", "yes");
    });
  }
  const route = (path: string, answer: (reply: CelsianReply) => unknown) =>
    app.get(path, (_request, reply) => answer(reply) as Response);
  route("/te", (r) => r.header("transfer-encoding", "chunked").send("hello"));
  route("/te-json", (r) => r.header("transfer-encoding", "chunked").json({ a: 1 }));
  route("/te-and-length", (r) => r.header("transfer-encoding", "chunked").header("content-length", "5").send("hello"));
  route("/te-empty", (r) => r.header("transfer-encoding", "chunked").send(null));
  route("/te-gzip", (r) => r.header("transfer-encoding", "gzip").send("hello"));
  route("/te-error", (r) => {
    r.header("transfer-encoding", "chunked");
    throw new Error("failed after setting a transfer coding");
  });
  route("/length-short", (r) => r.header("content-length", "3").send("hello"));
  route("/length-long", (r) => r.header("content-length", "10").send("hello"));
  route("/length-empty", (r) => r.header("content-length", "5").send(null));
  route("/close", (r) => r.header("connection", "close").send("hello"));
  route("/keep-alive", (r) => r.header("connection", "keep-alive").send("hello"));
  route("/upgrade", (r) => r.header("connection", "upgrade").header("upgrade", "websocket").send("hello"));
  route("/informational", (r) => r.status(101).send("hello"));
  route("/no-content", (r) =>
    r.status(204).header("content-length", "5").header("transfer-encoding", "chunked").send(null),
  );
  route("/not-modified", (r) => r.status(304).header("etag", '"v1"').header("content-length", "5").send(null));
  route("/not-modified-te", (r) =>
    r.status(304).header("transfer-encoding", "chunked").header("content-length", "5").send(null),
  );
  route("/plain", (r) => r.send("hello"));
  app.get("/after", () => "after");
}

describe.each([
  ["no hook", false],
  ["an onSend hook that adds a header", true],
])("core's Node server, a reply that sets framing headers, with %s", (_label, withHook) => {
  async function start(): Promise<number> {
    const app = createApp();
    routes(app, withHook);
    return listen(app);
  }

  /** The second request went out on the same connection and was answered. */
  function stillInStep(next: Answer): void {
    expect(next.status).toBe(200);
    expect(next.body).toBe("after");
    expect(next.reused).toBe(true);
  }

  it.each([
    ["/te", "hello"],
    ["/te-json", '{"a":1}'],
    ["/te-and-length", "hello"],
  ])("lets a chunked Transfer-Encoding frame the body, with no Content-Length (%s)", async (path, body) => {
    const { first, next } = await exchange(await start(), "GET", path);
    expect(first.status).toBe(200);
    expect(one(first, "transfer-encoding")).toEqual(["chunked"]);
    expect(one(first, "content-length")).toBeUndefined();
    expect(first.body).toBe(body);
    if (withHook) expect(one(first, "x-hook")).toEqual(["yes"]);
    stillInStep(next);
  });

  it("sends the error answer chunked when the reply set a chunked Transfer-Encoding before the throw", async () => {
    const { first, next } = await exchange(await start(), "GET", "/te-error");
    expect(first.status).toBe(500);
    expect(one(first, "transfer-encoding")).toEqual(["chunked"]);
    expect(one(first, "content-length")).toBeUndefined();
    expect(JSON.parse(first.body).error).toBe("failed after setting a transfer coding");
    stillInStep(next);
  });

  it("ends a chunked Transfer-Encoding with no body with the last chunk", async () => {
    const { first, next } = await exchange(await start(), "GET", "/te-empty");
    expect(first.status).toBe(200);
    expect(one(first, "transfer-encoding")).toEqual(["chunked"]);
    expect(one(first, "content-length")).toBeUndefined();
    expect(first.body).toBe("");
    stillInStep(next);
  });

  it("closes the connection after a body whose last transfer coding is not chunked", async () => {
    const { first, next } = await exchange(await start(), "GET", "/te-gzip");
    expect(first.status).toBe(200);
    expect(one(first, "transfer-encoding")).toEqual(["gzip"]);
    expect(one(first, "content-length")).toBeUndefined();
    expect(one(first, "connection")).toEqual(["close"]);
    // Read to the end of the connection, which is the only end such a body has.
    expect(first.body).toBe("hello");
    expect(next.status).toBe(200);
    expect(next.reused).toBe(false);
  });

  it.each(["/length-short", "/length-long"])(
    "sends the body's own Content-Length in place of one set on the reply (%s)",
    async (path) => {
      const { first, next } = await exchange(await start(), "GET", path);
      expect(first.status).toBe(200);
      expect(one(first, "content-length")).toEqual(["5"]);
      expect(one(first, "transfer-encoding")).toBeUndefined();
      expect(first.body).toBe("hello");
      stillInStep(next);
    },
  );

  it("sends Content-Length: 0 for no body, whatever length the reply set", async () => {
    const { first, next } = await exchange(await start(), "GET", "/length-empty");
    expect(first.status).toBe(200);
    expect(one(first, "content-length")).toEqual(["0"]);
    expect(first.body).toBe("");
    stillInStep(next);
  });

  it("closes the connection after the answer when the reply set Connection: close", async () => {
    const { first, next } = await exchange(await start(), "GET", "/close");
    expect(first.status).toBe(200);
    expect(one(first, "connection")).toEqual(["close"]);
    expect(one(first, "content-length")).toEqual(["5"]);
    expect(first.body).toBe("hello");
    expect(next.status).toBe(200);
    expect(next.reused).toBe(false);
  });

  it("keeps the connection when the reply set Connection: keep-alive", async () => {
    const { first, next } = await exchange(await start(), "GET", "/keep-alive");
    expect(first.status).toBe(200);
    expect(one(first, "connection")).toEqual(["keep-alive"]);
    expect(first.body).toBe("hello");
    stillInStep(next);
  });

  it("sends Upgrade on a 200 as an ordinary header: no upgrade, the body framed by its length", async () => {
    const { first, next } = await exchange(await start(), "GET", "/upgrade");
    expect(first.upgraded).toBe(false);
    expect(first.status).toBe(200);
    expect(one(first, "upgrade")).toEqual(["websocket"]);
    expect(one(first, "content-length")).toEqual(["5"]);
    expect(first.body).toBe("hello");
    stillInStep(next);
  });

  it("answers 500 to a 1xx status, which no Response can carry", async () => {
    const { first, next } = await exchange(await start(), "GET", "/informational");
    expect(first.upgraded).toBe(false);
    expect(first.status).toBe(500);
    stillInStep(next);
  });

  it("sends neither Content-Length nor Transfer-Encoding with a 204", async () => {
    const { first, next } = await exchange(await start(), "GET", "/no-content");
    expect(first.status).toBe(204);
    expect(one(first, "content-length")).toBeUndefined();
    expect(one(first, "transfer-encoding")).toBeUndefined();
    expect(first.body).toBe("");
    stillInStep(next);
  });

  it("keeps a 304's Content-Length, which describes the content, and sends no body", async () => {
    const { first, next } = await exchange(await start(), "GET", "/not-modified");
    expect(first.status).toBe(304);
    expect(one(first, "content-length")).toEqual(["5"]);
    expect(one(first, "etag")).toEqual(['"v1"']);
    expect(first.body).toBe("");
    stillInStep(next);
  });

  it("drops a 304's Content-Length when the reply also set a Transfer-Encoding", async () => {
    const port = await start();
    const { first, next } = await exchange(port, "GET", "/not-modified-te");
    expect(first.status).toBe(304);
    expect(one(first, "transfer-encoding")).toEqual(["chunked"]);
    expect(one(first, "content-length")).toBeUndefined();
    // Node's server closes the connection after a 304 that carries a
    // Transfer-Encoding (as on ef8953c), so the next request has a new one.
    expect(next.status).toBe(200);
    expect(next.body).toBe("after");
  });

  describe("HEAD", () => {
    it.each([
      ["/plain", undefined, undefined],
      ["/te", "chunked", undefined],
      ["/te-and-length", "chunked", undefined],
      ["/length-empty", undefined, "5"],
    ])("sends no body and leaves the connection in step (%s)", async (path, codings, length) => {
      const port = await start();
      const { first } = await exchange(port, "HEAD", path);
      expect(first.status).toBe(200);
      expect(first.body).toBe("");
      expect(one(first, "transfer-encoding")).toEqual(codings === undefined ? undefined : [codings]);
      expect(one(first, "content-length")).toEqual(length === undefined ? undefined : [length]);
      const { head, rest } = await pipelined(port, "HEAD", path);
      expect(head.startsWith("http/1.1 200")).toBe(true);
      expect(rest.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(rest.endsWith("\r\n\r\nafter")).toBe(true);
    });

    it("sends neither Content-Length nor Transfer-Encoding with a 204", async () => {
      const port = await start();
      const { first } = await exchange(port, "HEAD", "/no-content");
      expect(first.status).toBe(204);
      expect(one(first, "content-length")).toBeUndefined();
      expect(one(first, "transfer-encoding")).toBeUndefined();
      const { rest } = await pipelined(port, "HEAD", "/no-content");
      expect(rest.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
    });
  });
});

describe("core's Node server, a Transfer-Encoding on a streamed response", () => {
  it("sends no Content-Length beside it, and closes after a body whose last coding is not chunked", async () => {
    const app = createApp();
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      });
    app.get(
      "/chunked",
      () => new Response(stream(), { headers: { "transfer-encoding": "chunked", "content-length": "5" } }),
    );
    app.get("/gzip", () => new Response(stream(), { headers: { "transfer-encoding": "gzip" } }));
    app.get("/after", () => "after");
    const port = await listen(app);

    const chunked = await exchange(port, "GET", "/chunked");
    expect(one(chunked.first, "transfer-encoding")).toEqual(["chunked"]);
    expect(one(chunked.first, "content-length")).toBeUndefined();
    expect(chunked.first.body).toBe("hello");
    expect(chunked.next.reused).toBe(true);

    const gzip = await exchange(port, "GET", "/gzip");
    expect(one(gzip.first, "connection")).toEqual(["close"]);
    expect(gzip.first.body).toBe("hello");
    expect(gzip.next.reused).toBe(false);
    expect(gzip.next.body).toBe("after");
  });
});

describe("core's Node server, the raw bytes of a chunked Transfer-Encoding set on the reply", () => {
  it("are one chunk and the last chunk, after a header block with no Content-Length", async () => {
    const app = createApp();
    app.addHook("onSend", (_request, reply) => {
      reply.header("x-hook", "yes");
    });
    app.get("/te", (_request, reply) => reply.header("transfer-encoding", "chunked").send("hello"));
    const port = await listen(app);
    const wire = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.write("GET /te HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      });
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    });
    const [head, body] = wire.split("\r\n\r\n", 2) as [string, string];
    expect(head.toLowerCase()).toContain("\r\ntransfer-encoding: chunked");
    expect(head.toLowerCase()).not.toContain("content-length");
    expect(wire.slice(head.length + 4)).toBe("5\r\nhello\r\n0\r\n\r\n");
    expect(body.startsWith("5\r\nhello")).toBe(true);
  });
});
