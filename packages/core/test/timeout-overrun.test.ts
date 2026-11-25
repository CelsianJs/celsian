// @celsian/core -- what a request that works past its deadline synchronously gets, over a real socket
//
// A timer cannot interrupt synchronous work. A request whose hooks or handler
// work past the request timeout before anything waits is decided at its first
// wait: if the lifecycle then settles on microtasks alone (or on a
// process.nextTick), it answers as it would have; if it waits on anything the
// event loop has to come round for (an immediate, a timer, I/O), it is answered
// 504 before what it waits on runs, and resumes with request.signal aborted.
//
// That last part is a change from ef8953c, where such a request could still
// answer 200: there the timer was set when the lifecycle began, after the first
// onRequest hook's synchronous work and due only once the event loop reached
// timers, so a handler that waited on an immediate (or a first request whose
// pipelined neighbour was answered in between) resumed before it fired. The
// changeset sets out the before and after; this file pins the after.
//
// Real sockets, because the order of a process.nextTick and the microtask
// queue differs between a server callback and a promise chain: on Node a tick
// queued from the callback itself runs before the microtasks queued with it.

import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CelsianApp, createApp } from "../src/app.js";
import { type ServeResult, serve } from "../src/serve.js";
import type { CelsianReply, CelsianRequest } from "../src/types.js";

const servers: ServeResult[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

async function listen(app: CelsianApp): Promise<number> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  let port = 0;
  servers.push(
    await serve(app, {
      port: 0,
      host: "127.0.0.1",
      handleFatalErrors: false,
      shutdownTimeout: 100,
      onReady: (info) => {
        port = info.port;
      },
    }),
  );
  return port;
}

/** `wire` written to a new connection; everything the server sends back until it closes. */
function exchange(port: number, wire: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" }, () => socket.write(wire));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
  });
}

const GET = "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";

/** Each response's status and body, in the order they were sent. */
function responses(raw: string): { status: number; body: string }[] {
  return raw
    .split(/(?=HTTP\/1\.1 \d{3} )/)
    .filter((part) => part.startsWith("HTTP/1.1 "))
    .map((part) => {
      const [head, ...rest] = part.split("\r\n\r\n");
      const body = rest.join("\r\n\r\n");
      const chunked = /\r\ntransfer-encoding: chunked/i.test(head as string);
      return { status: Number((head as string).slice(9, 12)), body: chunked ? dechunk(body) : body };
    });
}

function dechunk(body: string): string {
  let out = "";
  let rest = body;
  for (;;) {
    const line = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, line), 16);
    if (!(size > 0)) return out;
    out += rest.slice(line + 2, line + 2 + size);
    rest = rest.slice(line + 2 + size + 2);
  }
}

/** Synchronous work that takes `ms` whatever the machine's load: past any deadline shorter than that. */
function work(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {}
}

const TIMEOUT = 15;
const OVERRUN = 40;

/** What the work waits on after its overrun (null: it answers with no wait), and the status it then gets. */
const WAITS: { kind: string; wait: (() => Promise<unknown>) | null; status: number }[] = [
  { kind: "nothing: it answers synchronously", wait: null, status: 200 },
  {
    kind: "only microtasks",
    wait: async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
    },
    status: 200,
  },
  { kind: "a process.nextTick", wait: () => new Promise<void>((resolve) => process.nextTick(resolve)), status: 200 },
  { kind: "an immediate", wait: () => new Promise<void>((resolve) => setImmediate(resolve)), status: 504 },
  { kind: "a timer", wait: () => new Promise<void>((resolve) => setTimeout(resolve, 0)), status: 504 },
  { kind: "I/O", wait: () => readFile(new URL(import.meta.url)), status: 504 },
];

/** The body of the 504, outside production (where it also carries the stack). */
function gatewayTimeout(body: string | undefined): boolean {
  const parsed = JSON.parse(body ?? "null") as { error?: unknown; statusCode?: unknown; code?: unknown } | null;
  return parsed?.error === "Gateway Timeout" && parsed.statusCode === 504 && parsed.code === "GATEWAY_TIMEOUT";
}

describe.each([
  ["the handler", "handler"],
  ["an onRequest hook", "onRequest"],
] as const)("%s works past the request timeout synchronously, then", (_label, where) => {
  it.each(WAITS)("waits on $kind: answered $status", async ({ wait, status }) => {
    const app = createApp({ requestTimeout: TIMEOUT });
    const seen: string[] = [];
    const run = (request: CelsianRequest): undefined | Promise<void> => {
      const signal = request.signal;
      work(OVERRUN);
      if (wait === null) {
        seen.push(`answered, signal aborted: ${signal.aborted}`);
        return undefined;
      }
      return wait().then(() => {
        seen.push(`resumed, signal aborted: ${signal.aborted}`);
      });
    };
    if (where === "handler") {
      app.get("/", (request) => {
        const pending = run(request);
        return pending === undefined ? "ok" : pending.then(() => "ok");
      });
    } else {
      app.addHook("onRequest", (request) => run(request));
      app.get("/", () => "ok");
    }

    const [answer] = responses(await exchange(await listen(app), GET));
    expect(answer?.status).toBe(status);
    if (status === 200) expect(answer?.body).toBe("ok");
    else expect(gatewayTimeout(answer?.body)).toBe(true);
    // A 504 comes before what the work waited on; it resumes with its signal aborted.
    await expect.poll(() => seen, { timeout: 2000 }).toHaveLength(1);
    expect(seen).toEqual([
      wait === null ? "answered, signal aborted: false" : `resumed, signal aborted: ${status === 504}`,
    ]);
  });
});

describe("a request past its deadline that had already built its answer", () => {
  it.each([WAITS[1], WAITS[3]] as { kind: string; wait: () => Promise<unknown>; status: number }[])(
    "with reply.send(), then waiting on $kind: answered $status",
    async ({ wait, status }) => {
      const app = createApp({ requestTimeout: TIMEOUT });
      app.get("/", (_request, reply: CelsianReply) => {
        const answer = reply.send("sent");
        work(OVERRUN);
        return wait().then(() => answer);
      });
      const [answer] = responses(await exchange(await listen(app), GET));
      expect(answer?.status).toBe(status);
      if (status === 200) expect(answer?.body).toBe("sent");
      else expect(gatewayTimeout(answer?.body)).toBe(true);
    },
  );

  it("returned as a stream at once: the deadline covers the lifecycle, not the body", async () => {
    const app = createApp({ requestTimeout: TIMEOUT });
    const encoder = new TextEncoder();
    app.get(
      "/",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("a"));
            },
            pull(controller) {
              // The producer overruns too, after the lifecycle has settled.
              work(OVERRUN);
              controller.enqueue(encoder.encode("b"));
              controller.close();
            },
          }),
        ),
    );
    const [answer] = responses(await exchange(await listen(app), GET));
    expect(answer).toEqual({ status: 200, body: "ab" });
  });
});

describe("two pipelined requests, the first past its deadline and then waiting on an immediate", () => {
  it("get one response each, in order: the first 504, the second its own answer", async () => {
    const app = createApp({ requestTimeout: TIMEOUT });
    const order: string[] = [];
    app.addHook("onResponse", (_request, reply) => {
      order.push(`onResponse ${reply.statusCode}`);
    });
    app.get("/slow", async (request) => {
      work(OVERRUN);
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push(`slow resumed, signal aborted: ${request.signal.aborted}`);
      return "slow";
    });
    app.get("/fast", () => {
      order.push("fast answered");
      return "fast";
    });
    const raw = await exchange(
      await listen(app),
      "GET /slow HTTP/1.1\r\nHost: x\r\n\r\nGET /fast HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    const [first, second, ...more] = responses(raw);
    expect(first?.status).toBe(504);
    expect(gatewayTimeout(first?.body)).toBe(true);
    expect(second).toEqual({ status: 200, body: "fast" });
    expect(more).toEqual([]);
    await expect.poll(() => order, { timeout: 2000 }).toContain("slow resumed, signal aborted: true");
    // Node hands the app the second request while the first is still pending.
    expect(order).toEqual(["fast answered", "onResponse 200", "onResponse 504", "slow resumed, signal aborted: true"]);
  });
});
