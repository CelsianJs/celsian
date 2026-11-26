// @celsian/core -- when a body is read straight from the Node stream, and how that read ends
//
// On core's Node server the body parser reads the IncomingMessage itself
// instead of the web stream wrapped around it (see takeNodeBody in request.ts
// and readNodeBody in body-parser.ts). serve-body-read.test.ts pins that over
// real sockets. A real socket cannot produce each condition on its own,
// though: a hang-up emits "error" and "close" together, a body that something
// else read is both "read" and "used". So the guards are pinned here one at a
// time, with a Node stream the test controls.

import { connect } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { parseBodyIfAny, readBodyText } from "../src/body-parser.js";
import { HttpError } from "../src/errors.js";
import { buildRequestFast, clearNodeBody, setNodeBody, takeNodeBody } from "../src/request.js";
import { type ServeResult, serve } from "../src/serve.js";
import type { CelsianRequest } from "../src/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NO_PARSERS = new Map<string, (request: Request) => Promise<unknown>>();
const LIMIT = 1024;

/** A Node stream the test feeds by hand. */
function nodeStream(options: { emitClose?: boolean } = {}): Readable {
  return new Readable({ read() {}, emitClose: options.emitClose ?? true });
}

/**
 * A request as core's Node server builds it: a Request whose body is offered
 * as `stream`. The Request's own body says "from the request" so a test can
 * tell which of the two was read.
 */
function requestOver(
  stream: Readable,
  contentType = "application/json",
  headers: Record<string, string> = {},
): { source: Request; request: CelsianRequest } {
  const source = new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body: '"from the request"',
  });
  setNodeBody(source, stream);
  return { source, request: buildRequestFast(source, "/x", "", {}, "http://localhost/x") };
}

/** How a promise stands after `ms`: its value, its rejection, or still pending. */
async function outcome<T>(
  promise: Promise<T> | undefined,
  ms = 200,
): Promise<{ value: T } | { error: unknown } | "pending"> {
  if (promise === undefined) return "pending";
  return Promise.race([
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
    sleep(ms).then(() => "pending" as const),
  ]);
}

function listeners(stream: Readable): number {
  return ["data", "end", "error", "close"].reduce((sum, event) => sum + stream.listenerCount(event), 0);
}

describe("offering a request's Node stream to the body parser", () => {
  it("offers it once", () => {
    const stream = nodeStream();
    const { request } = requestOver(stream);

    expect(takeNodeBody(request)).toBe(stream);
    // Whoever took it is reading it. A second reader would split the bytes.
    expect(takeNodeBody(request)).toBeUndefined();
    expect(takeNodeBody(request)).toBeUndefined();
  });

  it("does not offer a Node stream that something has already read from", async () => {
    const stream = nodeStream();
    const { source, request } = requestOver(stream);
    stream.push("abc");
    await new Promise<void>((resolve) => stream.once("data", () => resolve()));
    stream.pause();

    // The Request itself is untouched, so only the stream's own record says so.
    expect(source.bodyUsed).toBe(false);
    expect(source.body?.locked).toBe(false);
    expect(stream.readableDidRead).toBe(true);
    expect(takeNodeBody(request)).toBeUndefined();
  });

  it("does not offer it once the Request's own body has been used", async () => {
    const stream = nodeStream();
    const { source, request } = requestOver(stream);
    // Read through a reader that is then released: used, but not locked.
    const reader = source.body?.getReader();
    await reader?.read();
    reader?.releaseLock();

    // The Node stream is untouched, so only the Request says so.
    expect(stream.readableDidRead).toBe(false);
    expect(source.body?.locked).toBe(false);
    expect(source.bodyUsed).toBe(true);
    expect(takeNodeBody(request)).toBeUndefined();
  });

  it("does not offer it while something holds a reader on the Request's body", () => {
    const stream = nodeStream();
    const { source, request } = requestOver(stream);
    const reader = source.body?.getReader();

    expect(source.bodyUsed).toBe(false);
    expect(takeNodeBody(request)).toBeUndefined();
    reader?.releaseLock();
  });

  it("does not offer it once it was withdrawn, or for a request that never had one", () => {
    const stream = nodeStream();
    const { source, request } = requestOver(stream);
    clearNodeBody(source);
    expect(takeNodeBody(request)).toBeUndefined();

    const plain = new Request("http://localhost/x", { method: "POST", body: "x" });
    expect(takeNodeBody(buildRequestFast(plain, "/x", "", {}, "http://localhost/x"))).toBeUndefined();
    // Not a fast wrapper at all.
    expect(takeNodeBody(plain)).toBeUndefined();
  });
});

describe("reading a body from the Node stream", () => {
  it("parses JSON and text from the stream, not from the Request", async () => {
    const json = nodeStream();
    const first = requestOver(json);
    const parsing = parseBodyIfAny(first.request, LIMIT, NO_PARSERS);
    json.push('{"from":');
    json.push('"the stream"}');
    json.push(null);
    expect(await outcome(parsing)).toEqual({ value: undefined });
    expect(first.request.parsedBody).toEqual({ from: "the stream" });
    expect(listeners(json)).toBe(0);

    const text = nodeStream();
    const second = requestOver(text, "text/plain");
    const reading = parseBodyIfAny(second.request, LIMIT, NO_PARSERS);
    // A three-byte character split across two chunks.
    const snowman = Buffer.from("☃");
    text.push(Buffer.concat([Buffer.from("a "), snowman.subarray(0, 1)]));
    text.push(snowman.subarray(1));
    text.push(null);
    await reading;
    expect(second.request.parsedBody).toBe("a ☃");
  });

  it("answers 400 when the stream closes before its end, with no error", async () => {
    for (const [contentType, code] of [
      ["application/json", "INVALID_JSON"],
      ["text/plain", "INVALID_BODY"],
    ] as const) {
      const stream = nodeStream();
      const { request } = requestOver(stream, contentType);
      const parsing = parseBodyIfAny(request, LIMIT, NO_PARSERS);
      stream.push('{"partial"');
      await sleep(5);
      // "close" alone: no "end", and destroy() without an error emits no "error".
      stream.destroy();

      const result = await outcome(parsing);
      expect(result, contentType).not.toBe("pending");
      const error = (result as { error: HttpError }).error;
      expect(error).toBeInstanceOf(HttpError);
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe(code);
      expect(error.message).toContain("aborted");
      expect(request.parsedBody).toBeUndefined();
      expect(listeners(stream)).toBe(0);
    }
  });

  it("answers 400 with the stream's own error when it fails, with no close", async () => {
    // A stream that reports its failure and never emits "close".
    const stream = nodeStream({ emitClose: false });
    const { request } = requestOver(stream);
    const parsing = parseBodyIfAny(request, LIMIT, NO_PARSERS);
    stream.push('{"partial"');
    await sleep(5);
    const failure = new Error("socket hang up");
    stream.destroy(failure);

    const result = await outcome(parsing);
    expect(result).not.toBe("pending");
    const error = (result as { error: HttpError }).error;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("INVALID_JSON");
    expect(error.message).toContain("socket hang up");
    expect(error.cause).toBe(failure);
    expect(listeners(stream)).toBe(0);
  });

  it("answers 400 at once for a stream that was destroyed before the read began", async () => {
    const stream = nodeStream();
    const { request } = requestOver(stream);
    stream.destroy();
    await new Promise<void>((resolve) => stream.once("close", () => resolve()));
    expect(stream.destroyed).toBe(true);
    expect(stream.readableDidRead).toBe(false);

    // Its "close" has already been emitted: waiting for one would wait forever.
    const result = await outcome(parseBodyIfAny(request, LIMIT, NO_PARSERS));
    expect(result).not.toBe("pending");
    const error = (result as { error: HttpError }).error;
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("aborted");
    expect(listeners(stream)).toBe(0);
  });

  // An empty body can end without a single "data" event, and a Node stream
  // that has ended is destroyed straight after. Nothing was read from it, so
  // it is still offered, and it is an empty body, not a client that went away:
  // the read must not wait for an "end" that has already been emitted, nor
  // take the destroyed stream for an aborted one.
  it.each([
    ["application/json", undefined],
    ["text/plain", ""],
  ] as const)("parses an empty %s body whose stream ended before the read began", async (type, parsed) => {
    const stream = nodeStream();
    const { request } = requestOver(stream, type);
    stream.push(null);
    stream.resume();
    await new Promise<void>((resolve) => stream.once("end", () => resolve()));
    expect(stream.readableEnded).toBe(true);
    expect(stream.readableDidRead).toBe(false);
    expect(stream.destroyed).toBe(true);

    const result = await outcome(parseBodyIfAny(request, LIMIT, NO_PARSERS));
    expect(result).toEqual({ value: undefined });
    expect(request.parsedBody).toBe(parsed);
    expect(listeners(stream)).toBe(0);
  });

  it("answers 413 as soon as the limit is passed, and stops the stream there", async () => {
    const stream = nodeStream();
    const { request } = requestOver(stream, "text/plain");
    const settled = outcome(parseBodyIfAny(request, 8, NO_PARSERS));
    stream.push("12345");
    stream.push("67890");

    const result = await settled;
    const error = (result as { error: HttpError }).error;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.statusCode).toBe(413);
    expect(error.message).toContain("8 byte limit");
    // Paused, with nothing listening: the rest of the upload is not pulled
    // into memory, and not thrown away as it would be from a flowing stream
    // with no listener.
    expect(stream.isPaused()).toBe(true);
    expect(listeners(stream)).toBe(0);
    stream.push("more");
    await sleep(5);
    expect(stream.readableLength).toBeGreaterThan(0);
    stream.destroy();
  });

  it("answers 413 from the declared length alone, without taking the stream", async () => {
    const stream = nodeStream();
    const { request } = requestOver(stream, "application/json", { "content-length": "100" });

    const result = await outcome(parseBodyIfAny(request, 8, NO_PARSERS));
    expect((result as { error: HttpError }).error.statusCode).toBe(413);
    expect(listeners(stream)).toBe(0);
    // Still on offer: nothing took it.
    expect(takeNodeBody(request)).toBe(stream);
  });

  it("answers 400 INVALID_JSON for a body that is not JSON, and lets go of the stream", async () => {
    const stream = nodeStream();
    const { request } = requestOver(stream);
    const parsing = parseBodyIfAny(request, LIMIT, NO_PARSERS);
    stream.push("{not json");
    stream.push(null);

    const error = ((await outcome(parsing)) as { error: HttpError }).error;
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("INVALID_JSON");
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(listeners(stream)).toBe(0);
  });

  it("leaves parsedBody undefined for an empty or blank JSON body, and '' for an empty text body", async () => {
    for (const [contentType, chunks, expected] of [
      ["application/json", [], undefined],
      ["application/json", ["  \n"], undefined],
      ["text/plain", [], ""],
    ] as const) {
      const stream = nodeStream();
      const { request } = requestOver(stream, contentType);
      const parsing = parseBodyIfAny(request, LIMIT, NO_PARSERS);
      for (const chunk of chunks) stream.push(chunk);
      stream.push(null);
      await parsing;
      expect(request.parsedBody, `${contentType} ${JSON.stringify(chunks)}`).toBe(expected);
    }
  });
});

// bodyLimit 0 means no limit. The direct read counts bytes against the limit
// as they arrive, so with 0 it would refuse the first byte of every body. With
// no limit to enforce, the body is read through the Request, as it always was.
describe("with no body limit", () => {
  it("reads through the Request and leaves the Node stream alone", async () => {
    for (const contentType of ["application/json", "text/plain"]) {
      const stream = nodeStream();
      const { request } = requestOver(stream, contentType);
      await parseBodyIfAny(request, 0, NO_PARSERS);

      expect(request.parsedBody, contentType).toBe(
        contentType === "application/json" ? "from the request" : '"from the request"',
      );
      expect(stream.readableDidRead).toBe(false);
      expect(listeners(stream)).toBe(0);
    }

    const stream = nodeStream();
    const { request } = requestOver(stream, "text/plain");
    expect(await readBodyText(request as unknown as Request, 0)).toBe('"from the request"');
    expect(stream.readableDidRead).toBe(false);
  });

  it("does not hold a declared length against a limit of 0", async () => {
    const declared = () =>
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": "5" },
        body: "hello",
      });
    expect(await readBodyText(declared(), 0)).toBe("hello");
    await expect(readBodyText(declared(), 4)).rejects.toMatchObject({ statusCode: 413 });

    const app = createApp({ bodyLimit: 0 });
    app.post("/echo", (req) => ({ got: req.parsedBody }));
    for (const [contentType, payload, got] of [
      ["application/json", '{"a":1}', { a: 1 }],
      ["text/plain", "hello", "hello"],
    ] as const) {
      const res = await app.handle(
        new Request("http://localhost/echo", {
          method: "POST",
          headers: { "content-type": contentType, "content-length": String(payload.length) },
          body: payload,
        }),
      );
      expect(res.status, contentType).toBe(200);
      expect(await res.json()).toEqual({ got });
    }
  });

  describe("over a real socket", () => {
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

    it("accepts JSON, text, form and custom-parser bodies of any size", async () => {
      const app = createApp({ bodyLimit: 0 });
      app.addContentTypeParser("application/x-custom", async (request) => `custom:${await request.text()}`);
      app.post("/echo", (req, reply) => {
        const body = req.parsedBody;
        return reply.json({ got: body instanceof FormData ? Object.fromEntries(body.entries()) : body });
      });
      const base = await listen(app);
      // Sent as a stream, so chunked and with no declared length.
      const post = async (contentType: string, body: string) => {
        const res = await fetch(`${base}/echo`, {
          method: "POST",
          headers: { "content-type": contentType },
          body: new Blob([body]).stream(),
          duplex: "half",
        } as RequestInit);
        return { status: res.status, body: (await res.json()) as { got: unknown } };
      };

      const big = "x".repeat(2 * 1024 * 1024);
      expect(await post("application/json", JSON.stringify({ a: 1 }))).toEqual({
        status: 200,
        body: { got: { a: 1 } },
      });
      expect(await post("text/plain", "hello")).toEqual({ status: 200, body: { got: "hello" } });
      expect(await post("application/x-www-form-urlencoded", "a=1&b=2")).toEqual({
        status: 200,
        body: { got: { a: "1", b: "2" } },
      });
      expect(await post("application/x-custom", "raw")).toEqual({ status: 200, body: { got: "custom:raw" } });
      // Past the default 1 MB limit, which is not in force.
      const large = await post("application/json", JSON.stringify({ big }));
      expect(large.status).toBe(200);
      expect((large.body.got as { big: string }).big.length).toBe(big.length);
    });

    it("accepts bodies that declare their length, as nearly every client does", async () => {
      const app = createApp({ bodyLimit: 0 });
      app.post("/echo", (req, reply) => {
        const body = req.parsedBody;
        return reply.json({ got: body instanceof FormData ? Object.fromEntries(body.entries()) : body });
      });
      const base = await listen(app);
      const post = async (contentType: string, body: string) => {
        const res = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": contentType }, body });
        return { status: res.status, body: (await res.json()) as { got: unknown } };
      };

      expect(await post("application/json", JSON.stringify({ a: 1 }))).toEqual({
        status: 200,
        body: { got: { a: 1 } },
      });
      expect(await post("text/plain", "hello")).toEqual({ status: 200, body: { got: "hello" } });
      expect(await post("application/x-www-form-urlencoded", "a=1&b=2")).toEqual({
        status: 200,
        body: { got: { a: "1", b: "2" } },
      });
      const big = "x".repeat(2 * 1024 * 1024);
      const large = await post("application/json", JSON.stringify({ big }));
      expect(large.status).toBe(200);
      expect((large.body.got as { big: string }).big.length).toBe(big.length);
    });

    it("answers a client that hangs up mid-body through the error path with a 400, and never runs the handler", async () => {
      const app = createApp();
      let handlerRan = false;
      const errors: { statusCode?: number; code?: string; message: string }[] = [];
      const statuses: number[] = [];
      app.addHook("onError", (error) => {
        errors.push(error as { statusCode?: number; code?: string; message: string });
      });
      app.addHook("onResponse", (_request, reply) => {
        statuses.push(reply.statusCode);
      });
      app.post("/json", (req, reply) => {
        handlerRan = true;
        return reply.json({ got: req.parsedBody });
      });
      await listen(app);

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
      await expect.poll(() => statuses.length, { timeout: 2000 }).toBe(1);

      expect(handlerRan).toBe(false);
      expect(statuses).toEqual([400]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.statusCode).toBe(400);
      expect(errors[0]?.code).toBe("INVALID_JSON");
      expect(errors[0]?.message).toContain("aborted");
    });
  });
});
