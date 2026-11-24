// Child process of alloc-gate.mjs: starts ONE framework server and counts what
// each request costs it. Counters, not timings: promises and timers through
// async_hooks, web primitives through wrapped global constructors, and
// young-generation collections through a GC performance observer.
//
// Usage: node alloc-server.mjs <celsian|express|fastify|hono>[:headers]
// It listens on an OS-assigned port and talks to the parent over IPC:
//   child -> { ready: port }      parent -> "begin"   child -> "go"
//   parent -> "end"               child -> { counts, ctor, minorGC, majorGC }
//   parent -> "exit"
//
// Nothing in here may allocate per request on its own account, or it would be
// charged to the framework: the hook and the constructor traps only bump
// integers.

import { createHook } from "node:async_hooks";
import { createRequire } from "node:module";
import { PerformanceObserver } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const [framework = "celsian", variant = "plain"] = (process.argv[2] ?? "celsian").split(":");
const withHeaders = variant === "headers";

let counting = false;
const counts = { PROMISE: 0, Timeout: 0 };
// ALLOC_TRACE=<type> prints one stack per distinct creation site, for finding
// out where a count comes from. Never set by the gate.
const traceType = process.env.ALLOC_TRACE;
const traceSites = new Map();
function trace(type) {
  if (traceType !== type && traceType !== "all") return;
  const stack = new Error(type).stack.split("\n").slice(2, 12).join("\n");
  traceSites.set(stack, (traceSites.get(stack) ?? 0) + 1);
}

createHook({
  init(_id, type) {
    if (!counting) return;
    if (type === "PROMISE") counts.PROMISE++;
    else if (type === "Timeout") counts.Timeout++;
    else return;
    if (traceType !== undefined) trace(type);
  },
}).enable();

let minorGC = 0;
let majorGC = 0;
new PerformanceObserver((list) => {
  if (!counting) return;
  for (const entry of list.getEntries()) {
    // detail.kind 1 is a scavenge (young generation); everything else is old-space work.
    if (entry.detail?.kind === 1) minorGC++;
    else majorGC++;
  }
}).observe({ entryTypes: ["gc"] });

// Web primitives a framework constructs through the globals. Node's own fetch
// implementation resolves these lazily too, so objects it builds internally
// (the AbortController and ReadableStream inside `new Request`/`new Response`)
// are counted as well.
const ctor = {
  AbortController: 0,
  Request: 0,
  Response: 0,
  Headers: 0,
  ReadableStream: 0,
  URL: 0,
  URLSearchParams: 0,
  TextDecoder: 0,
};
for (const name of Object.keys(ctor)) {
  const Original = globalThis[name];
  const Wrapped = new Proxy(Original, {
    construct(target, args, newTarget) {
      if (counting) {
        ctor[name]++;
        if (traceType !== undefined) trace(name);
      }
      return Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
    },
  });
  globalThis[name] = Wrapped;
}

// The headers `cors()` and `security()` put on a response, set by hand in
// Express and Fastify (which have no built-in equivalent installed here) so
// they do the same work in the "headers" variant.
const EXTRA_HEADERS = [
  ["access-control-allow-origin", "*"],
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["x-xss-protection", "0"],
  ["strict-transport-security", "max-age=31536000; includeSubDomains"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["x-dns-prefetch-control", "off"],
  ["x-download-options", "noopen"],
  ["x-permitted-cross-domain-policies", "none"],
];

/** Start the server on an OS-assigned port and resolve with that port. */
async function start() {
  if (framework === "celsian") {
    const { createApp, serve, cors, security } = await import("@celsian/core");
    const app = createApp();
    if (withHeaders) {
      await app.register(cors(), { encapsulate: false });
      await app.register(security(), { encapsulate: false });
    }
    app.get("/json", (_req, reply) => reply.json({ message: "Hello, World!" }));
    app.get("/user/:id", (req, reply) =>
      reply.json({ id: req.params.id, name: `User ${req.params.id}`, email: `user${req.params.id}@test.com` }),
    );
    app.post("/echo", (req, reply) => reply.json(req.parsedBody));
    app.get("/error", () => {
      throw new Error("Intentional benchmark error");
    });
    // A body validated against a Zod schema, as most real POST routes are.
    const { z } = await import("zod");
    const body = z.object({
      name: z.string(),
      value: z.number(),
      nested: z.object({ a: z.number(), b: z.array(z.number()) }),
    });
    app.post("/validated", { schema: { body } }, (req, reply) => reply.json(req.parsedBody));
    const port = await new Promise((resolve) => {
      serve(app, { port: 0, host: "127.0.0.1", onReady: (info) => resolve(info.port) });
    });
    // serve() starts the background task worker and the cron scheduler. Both
    // poll on a timer whether or not a request is in flight, which would add
    // a few promises and timers per second of wall clock to the counts: noise
    // that grows with how slow the machine is. Neither is per-request work.
    await app.stopWorker();
    app.stopCron();
    return port;
  }

  if (framework === "express") {
    const express = require("express");
    const app = express();
    app.use(express.json());
    if (withHeaders) {
      app.use((_req, res, next) => {
        for (const [key, value] of EXTRA_HEADERS) res.setHeader(key, value);
        next();
      });
    }
    app.get("/json", (_req, res) => res.json({ message: "Hello, World!" }));
    app.get("/user/:id", (req, res) =>
      res.json({ id: req.params.id, name: `User ${req.params.id}`, email: `user${req.params.id}@test.com` }),
    );
    app.post("/echo", (req, res) => res.json(req.body));
    app.get("/error", () => {
      throw new Error("Intentional benchmark error");
    });
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    return new Promise((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
  }

  if (framework === "fastify") {
    const Fastify = require("fastify");
    const app = Fastify({ logger: false });
    if (withHeaders) {
      app.addHook("onSend", (_req, reply, payload, done) => {
        for (const [key, value] of EXTRA_HEADERS) reply.header(key, value);
        done(null, payload);
      });
    }
    app.get("/json", async () => ({ message: "Hello, World!" }));
    app.get("/user/:id", async (req) => ({
      id: req.params.id,
      name: `User ${req.params.id}`,
      email: `user${req.params.id}@test.com`,
    }));
    app.post("/echo", async (req) => req.body);
    app.get("/error", async () => {
      throw new Error("Intentional benchmark error");
    });
    app.setErrorHandler(async (error, _req, reply) => {
      reply.status(500).send({ error: error.message });
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    return app.server.address().port;
  }

  if (framework === "hono") {
    const { Hono } = require("hono");
    const { serve } = require("@hono/node-server");
    const app = new Hono();
    if (withHeaders) {
      // Hono ships its own equivalents of cors() and security().
      const { cors } = require("hono/cors");
      const { secureHeaders } = require("hono/secure-headers");
      app.use(cors());
      app.use(secureHeaders());
    }
    app.get("/json", (c) => c.json({ message: "Hello, World!" }));
    app.get("/user/:id", (c) => {
      const id = c.req.param("id");
      return c.json({ id, name: `User ${id}`, email: `user${id}@test.com` });
    });
    app.post("/echo", async (c) => c.json(await c.req.json()));
    app.get("/error", () => {
      throw new Error("Intentional benchmark error");
    });
    app.onError((err, c) => c.json({ error: err.message }, 500));
    return new Promise((resolve) => {
      serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    });
  }

  throw new Error(`unknown framework: ${framework}`);
}

// The error scenario makes every request log a stack to stderr. Writing 20,000
// of them costs allocations that belong to the console, not the framework, and
// buries the report.
console.error = () => {};
console.log = () => {};

const port = await start();

process.on("message", (message) => {
  if (message === "begin") {
    counts.PROMISE = 0;
    counts.Timeout = 0;
    for (const name of Object.keys(ctor)) ctor[name] = 0;
    minorGC = 0;
    majorGC = 0;
    traceSites.clear();
    counting = true;
    process.send("go");
  } else if (message === "end") {
    counting = false;
    // GC entries are delivered to the observer asynchronously; give the last
    // batch a moment to arrive before reporting.
    setTimeout(() => {
      const sites = [...traceSites.entries()].sort((a, b) => b[1] - a[1]);
      process.send({ counts, ctor, minorGC, majorGC, sites });
    }, 100);
  } else if (message === "exit") {
    process.exit(0);
  }
});

process.send({ ready: port });
