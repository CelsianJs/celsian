// Per-request allocation gate. Counts what one request costs CelsianJS on Node
// and fails when a count rises above the checked-in ceiling.
//
//   pnpm test:alloc                            gate CelsianJS against alloc-ceilings.json
//   node benchmarks/alloc-gate.mjs --compare   also count Express, Fastify and Hono (never gated)
//   node benchmarks/alloc-gate.mjs --update    rewrite alloc-ceilings.json from this run
//   node benchmarks/alloc-gate.mjs --json      print the raw counts as JSON, gate as usual
//
// Needs `pnpm build` first: the CelsianJS server is the built `@celsian/core`.
//
// Environment: ALLOC_SCENARIOS=json,body limits the run to those scenarios
// (with --update, only their ceilings are rewritten), ALLOC_TRACE=PROMISE (or
// Timeout, AbortController, Request, Response, Headers, ReadableStream, URL)
// prints the stack of every place one is created.
//
// Synchronous and `async` handlers are separate scenarios. A handler declared
// `async` costs promises a synchronous one does not: its own, the one that
// waits for it, and one for each step after it that now has to wait as well.
// Most real handlers are `async`, so `jsonAsync` and `bodyAsync` are the
// numbers most applications get; `json` and `body` are the floor.
//
// `--compare` is like for like: within a scenario every framework runs the
// same handler style and answers with the same status, the same response
// headers (names and values) and the same body bytes (see alloc-server.mjs),
// and the run stops when they do not. A framework that cannot run a
// scenario's handler style is left out of that row, and the report says so.
// Read each scenario as a row-by-row comparison, not one scenario against
// another.
//
// Nothing here depends on where the repository is checked out. The one
// scenario that could, the thrown error, runs with NODE_ENV=production: in
// development CelsianJS puts the stack in the body, the stack holds absolute
// paths, and its young-generation GC total then grew by 0.84 per character of
// checkout path (613 on CI, over 720 in a deep directory).
//
// What is gated: promises, timers and web objects per request are exact, and
// the same on every Node version from 20 up (Node 24 creates fewer, never
// more). They are checked on whatever Node runs this. The young-generation GC
// total depends on the size of Node's own objects, so it is only compared on
// the Node major the ceilings were recorded on, and CI pins that major.
//
// What is not: work that allocates nothing counted here, or too little to
// move the GC total past its 10% margin. Two of the branch's optimisations
// are like that, and undoing either passes this gate: the exact-path lookup
// for static routes (it saves a canonicalization and a map lookup, no
// allocation) and adapting route schemas once at registration instead of per
// request. Unit tests pin both instead: router-static-fast-path.test.ts and
// route-validators.test.ts in packages/core/test. See benchmarks/README.md.
//
// Why counts and not timings: a request's promise, timer and object counts are
// a property of the code path, so they are the same on a laptop under load and
// on a shared CI runner. Requests/second is not, which is how the throughput
// table in RESULTS.md ended up with 30% standard deviations.
//
// How it counts: each (framework, scenario) pair gets its own child process
// (alloc-server.mjs) with a fixed 1 MB young generation. This process sends it
// WARMUP requests, tells it to start counting, sends N more one at a time over
// a single keep-alive connection, and reads the counters back. The client lives
// here, in the parent, so nothing it allocates is charged to the server.

import { fork } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CEILINGS_FILE = `${HERE}alloc-ceilings.json`;
const N = Number(process.env.ALLOC_N ?? 20000);
const WARMUP = Number(process.env.ALLOC_WARMUP ?? 2000);

const args = new Set(process.argv.slice(2));
const compare = args.has("--compare");
const update = args.has("--update");
const asJson = args.has("--json");

const BODY = JSON.stringify({ name: "test", value: 42, nested: { a: 1, b: [1, 2, 3] } });

/**
 * scenario -> the request to send and the answer to expect.
 * `variant` is the server variant (default "plain"), `env` the server's
 * NODE_ENV (default "development"), `celsianOnly` keeps it out of --compare,
 * `without` names frameworks left out of its --compare row, and why.
 */
const SCENARIOS = {
  json: { method: "GET", path: "/json", status: 200 },
  // The same route with an `async` handler.
  jsonAsync: { method: "GET", path: "/json-async", status: 200 },
  // Hono has no synchronous way to read a body, so it can only run the `async` row.
  body: { method: "POST", path: "/echo", body: BODY, status: 200, without: { hono: "no synchronous body read" } },
  bodyAsync: { method: "POST", path: "/echo-async", body: BODY, status: 200 },
  params: { method: "GET", path: "/user/42", status: 200 },
  notFound: { method: "GET", path: "/nope", status: 404 },
  // In production, so the body holds no stack and with it no checkout path.
  error: { method: "GET", path: "/error", status: 500, env: "production" },
  // The plain GET again, with cors() and security() registered.
  headers: { method: "GET", path: "/json", variant: "headers", status: 200 },
  // The POST again, with its body validated against a schema. Not compared:
  // each framework validates with a different library, which is what would be measured.
  validated: { method: "POST", path: "/validated", body: BODY, status: 200, celsianOnly: true },
};

/** Per-request counters that are gated, in report order. */
const EXACT = ["promises", "timers", "AbortController", "Request", "Response", "Headers", "ReadableStream", "URL"];
/**
 * A per-request counter passes while it stays within this fraction of one unit
 * of its ceiling. Every real regression adds at least one whole object per
 * request; the slack only absorbs process-level timers that fire about once a
 * second whatever the request rate (Node's HTTP date cache), so a slow runner
 * cannot fail the gate by taking longer.
 */
const EXACT_SLACK = 0.05;
/**
 * Young-generation GCs are not exactly repeatable: the total moves by a
 * percent or two between runs (it depends on when V8 finishes optimizing a
 * function) and by more between Node releases (it depends on the size of
 * Node's own HTTP and stream objects). `--update` records the measured total
 * plus this margin. It is the only ceiling that carries one.
 */
const GC_MARGIN = 0.1;

const nodeMajor = (version) => version.replace(/^v/, "").split(".")[0];

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    const req = http.request({ port, host: "127.0.0.1", method, path, agent, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    // One write, so headers and body leave in a single segment every time.
    req.end(body);
  });
}

/** Headers Node adds to every response whatever the framework. */
const TRANSPORT_HEADERS = new Set(["date", "connection", "keep-alive"]);

/**
 * What one response looks like on the wire, for checking that the frameworks
 * in a comparison answered alike: the status, every header the framework sent
 * with its value (sorted by name), and the body's bytes.
 */
function describeResponse(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    const req = http.request({ port, host: "127.0.0.1", method, path, agent, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        // Raw pairs, so a repeated header is seen as sent, and names as Node lowercases them.
        const sent = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i].toLowerCase();
          if (!TRANSPORT_HEADERS.has(name)) sent.push(`${name}: ${res.rawHeaders[i + 1]}`);
        }
        sent.sort();
        const bytes = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headerNames: [...new Set(sent.map((line) => line.slice(0, line.indexOf(":"))))].join(", "),
          headers: sent.join("\n"),
          body: bytes.toString("base64"),
          bodyBytes: bytes.length,
        });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function measure(framework, scenario) {
  const { method, path, body, variant = "plain", status: expected, env = "development" } = SCENARIOS[scenario];
  const child = fork(`${HERE}alloc-server.mjs`, [`${framework}:${variant}`], {
    execArgv: ["--min-semi-space-size=1", "--max-semi-space-size=1"],
    // An explicit NODE_ENV, the scenario's own, so every run measures the same
    // branch whatever the caller's environment says.
    env: { ...process.env, NODE_ENV: env },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const next = (predicate) =>
    new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (!predicate(message)) return;
        child.off("message", onMessage);
        child.off("exit", onExit);
        resolve(message);
      };
      const onExit = (code) => reject(new Error(`${framework} server exited early (code ${code})`));
      child.on("message", onMessage);
      child.once("exit", onExit);
    });

  try {
    const { ready: port } = await next((m) => typeof m === "object" && m !== null && "ready" in m);
    const wire = await describeResponse(port, method, path, body);
    for (let i = 0; i < WARMUP; i++) await request(port, method, path, body);
    child.send("begin");
    await next((m) => m === "go");
    for (let i = 0; i < N; i++) {
      const status = await request(port, method, path, body);
      if (status !== expected) {
        throw new Error(`${framework} ${scenario}: expected HTTP ${expected}, got ${status} on request ${i}`);
      }
    }
    child.send("end");
    const result = await next((m) => typeof m === "object" && m !== null && "counts" in m);
    if (process.env.ALLOC_TRACE !== undefined) {
      console.log(`\n--- ${framework} ${scenario}: creation sites for ${process.env.ALLOC_TRACE} (count over ${N} requests) ---`);
      for (const [stack, count] of result.sites) console.log(`${(count / N).toFixed(2)}/req\n${stack}\n`);
    }
    return {
      wire,
      promises: result.counts.PROMISE / N,
      timers: result.counts.Timeout / N,
      AbortController: result.ctor.AbortController / N,
      Request: result.ctor.Request / N,
      Response: result.ctor.Response / N,
      Headers: result.ctor.Headers / N,
      ReadableStream: result.ctor.ReadableStream / N,
      URL: result.ctor.URL / N,
      minorGCs: result.minorGC,
    };
  } finally {
    if (child.connected) child.send("exit");
    else child.kill();
  }
}

function fmt(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function printTable(title, rows) {
  const columns = ["", ...EXACT, "minorGCs"];
  const widths = columns.map((c) => c.length);
  const cells = rows.map(([label, counts]) => {
    const row = [label, ...EXACT.map((k) => fmt(counts[k])), String(counts.minorGCs)];
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], cell.length);
    });
    return row;
  });
  console.log(`\n${title}`);
  console.log(columns.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  "));
  for (const row of cells) {
    console.log(row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  "));
  }
}

const selected = (process.env.ALLOC_SCENARIOS ?? Object.keys(SCENARIOS).join(",")).split(",");
const frameworks = compare ? ["celsian", "express", "fastify", "hono"] : ["celsian"];
const ceilings = update ? {} : JSON.parse(readFileSync(CEILINGS_FILE, "utf8"));
// GC totals only mean something against ceilings recorded on the same Node major.
const gateGCs = !update && nodeMajor(ceilings.node ?? "") === nodeMajor(process.version);

if (!asJson) {
  console.log(
    `Node ${process.version}, ${N} sequential requests per scenario after ${WARMUP} warm-up, ` +
      `1 MB young generation. Per-request columns are averages over the run; minorGCs is the total. ` +
      `Load average ${os
        .loadavg()
        .map((x) => x.toFixed(1))
        .join(" ")} (counts do not depend on it).`,
  );
}

const measured = {};
const failures = [];
for (const scenario of selected) {
  if (!(scenario in SCENARIOS)) throw new Error(`unknown scenario: ${scenario}`);
  const rows = [];
  let celsianWire;
  const leftOut = [];
  for (const framework of frameworks) {
    if (framework !== "celsian" && SCENARIOS[scenario].celsianOnly === true) continue;
    const reason = SCENARIOS[scenario].without?.[framework];
    if (reason !== undefined) {
      leftOut.push(`${framework} (${reason})`);
      continue;
    }
    const { wire, ...counts } = await measure(framework, scenario);
    rows.push([framework, counts]);
    if (framework !== "celsian") {
      // A comparison is only worth printing when both sides did the same job:
      // the same status, the same headers with the same values, the same bytes.
      for (const key of ["status", "headers", "body"]) {
        if (wire[key] !== celsianWire[key]) {
          throw new Error(
            `${scenario}: not like for like. ${framework} answered with ${key} ${JSON.stringify(wire[key])}, ` +
              `celsian with ${JSON.stringify(celsianWire[key])}. Make the servers in alloc-server.mjs answer alike.`,
          );
        }
      }
      continue;
    }
    celsianWire = wire;
    measured[scenario] = counts;
    if (update) continue;
    const ceiling = ceilings.scenarios?.[scenario];
    if (ceiling === undefined) {
      failures.push(`${scenario}: no ceiling recorded in alloc-ceilings.json`);
      continue;
    }
    rows.push(["  ceiling", ceiling]);
    for (const key of EXACT) {
      if (counts[key] > ceiling[key] + EXACT_SLACK) {
        failures.push(`${scenario}: ${key} per request is ${fmt(counts[key])}, ceiling ${fmt(ceiling[key])}`);
      }
    }
    if (gateGCs && counts.minorGCs > ceiling.minorGCs) {
      failures.push(`${scenario}: ${counts.minorGCs} young-generation GCs per ${N} requests, ceiling ${ceiling.minorGCs}`);
    }
  }
  if (!asJson) {
    const { method, path, env = "development" } = SCENARIOS[scenario];
    const sent = `HTTP ${celsianWire.status}, ${celsianWire.bodyBytes} body bytes, headers: ${celsianWire.headerNames}`;
    printTable(`== ${scenario}: ${method} ${path} (NODE_ENV=${env}) -> ${sent} ==`, rows);
    if (compare && leftOut.length > 0) console.log(`  not run: ${leftOut.join(", ")}`);
  }
}

if (asJson) console.log(JSON.stringify(measured, null, 2));

if (update) {
  const scenarios = {};
  for (const [scenario, counts] of Object.entries(measured)) {
    const entry = {};
    // Per-request counters are whole numbers when nothing is leaking into the
    // window; round away the stray process-level timer so the ceiling is exact.
    for (const key of EXACT) entry[key] = Math.round(counts[key]);
    entry.minorGCs = Math.ceil(counts.minorGCs * (1 + GC_MARGIN));
    scenarios[scenario] = entry;
  }
  const previous = (() => {
    try {
      return JSON.parse(readFileSync(CEILINGS_FILE, "utf8")).scenarios ?? {};
    } catch {
      return {};
    }
  })();
  const file = {
    note:
      "Ceilings for benchmarks/alloc-gate.mjs (pnpm test:alloc). The per-request counters are exact. minorGCs is " +
      `the young-generation GC total over 'requests' requests, recorded ${GC_MARGIN * 100}% above the measured value and ` +
      "only compared on the Node major in 'node'. Regenerate with: pnpm build && node benchmarks/alloc-gate.mjs --update",
    node: process.version,
    requests: N,
    // In the order the scenarios are declared, whichever of them this run measured.
    scenarios: Object.fromEntries(
      Object.keys(SCENARIOS)
        .map((name) => [name, scenarios[name] ?? previous[name]])
        .filter(([, entry]) => entry !== undefined),
    ),
  };
  writeFileSync(CEILINGS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`\nWrote ${CEILINGS_FILE}`);
  process.exit(0);
}

if (failures.length > 0) {
  console.error("\nAllocation gate FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nA request now costs more than the recorded ceiling. Find the new allocation with\n" +
      "  ALLOC_SCENARIOS=<scenario> ALLOC_TRACE=PROMISE node benchmarks/alloc-gate.mjs\n" +
      "(ALLOC_TRACE also takes Timeout, AbortController, Request, Response, Headers, ReadableStream, URL).\n" +
      "If the increase is intended, raise the ceiling with\n" +
      "  pnpm build && node benchmarks/alloc-gate.mjs --update\n" +
      "on the Node major recorded in benchmarks/alloc-ceilings.json, and explain why in the pull request.",
  );
  process.exit(1);
}

if (!asJson) {
  console.log(
    gateGCs
      ? "\nAllocation gate passed."
      : `\nAllocation gate passed for the per-request counters. The GC ceilings were recorded on Node ${ceilings.node} ` +
          `and are not compared on ${process.version}.`,
  );
}
process.exit(0);
