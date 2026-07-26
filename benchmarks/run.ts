// benchmarks/run.ts - Comparative benchmark: CelsianJS vs Express vs Fastify vs Hono
//
// Usage: npx tsx benchmarks/run.ts
//        npx tsx benchmarks/run.ts --frameworks celsian,express
//        BENCH_REPS=7 BENCH_DURATION=10 npx tsx benchmarks/run.ts
//
// Methodology (see RESULTS.md for the write-up):
//   1. Every framework runs in its OWN child process (server-runner.ts), so the
//      server never shares a V8 heap, JIT state or event loop with autocannon.
//   2. Readiness is detected by polling the server, not by sleeping.
//   3. Every measured pass is preceded by a discarded warmup pass on the SAME
//      endpoint.
//   4. Each (framework, scenario) pair is measured BENCH_REPS times (default 5).
//      We report the median, the sample standard deviation and a 95% confidence
//      interval of the mean (Student t). Numbers are rounded to the nearest 100
//      req/s: the harness cannot resolve finer than that.
//   5. Framework order is reshuffled every repetition, so no framework
//      systematically absorbs thermal or warm-up bias.
//   6. Any autocannon result with unexpected errors, timeouts or non-2xx
//      responses invalidates the whole run (process exits non-zero).
//
// Memory is deliberately NOT measured here. All load runs against a child
// process while autocannon lives in this one, and a per-framework RSS number is
// only meaningful in a fresh, isolated process: use `benchmarks/mem.ts`.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";
import { frameworks as allFrameworks, type FrameworkDef } from "./frameworks.js";

// --- Configuration ---

const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 10);
const DURATION = Number(process.env.BENCH_DURATION ?? 5); // seconds, measured pass
const WARMUP = Number(process.env.BENCH_WARMUP ?? 2); // seconds, discarded pass
const REPS = Number(process.env.BENCH_REPS ?? 5);

const RUNNER = fileURLToPath(new URL("./server-runner.ts", import.meta.url));

interface Scenario {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: string;
  headers?: Record<string, string>;
  /** true when every response is expected to be non-2xx (the error scenario) */
  expectNon2xx?: boolean;
}

const scenarios: Scenario[] = [
  { name: "JSON response", method: "GET", path: "/json" },
  { name: "Route params", method: "GET", path: "/user/42" },
  { name: "Middleware chain (5)", method: "GET", path: "/middleware" },
  {
    name: "JSON body parsing",
    method: "POST",
    path: "/echo",
    body: JSON.stringify({ name: "benchmark", value: 12345, tags: ["perf", "test"], nested: { ok: true } }),
    headers: { "content-type": "application/json" },
  },
  { name: "Error handling", method: "GET", path: "/error", expectNon2xx: true },
];

// --- Statistics ---

/** Student t, two-sided 95%, indexed by degrees of freedom. */
const T95: Record<number, number> = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  11: 2.201,
  12: 2.179,
  13: 2.16,
  14: 2.145,
  15: 2.131,
  20: 2.086,
  25: 2.06,
  30: 2.042,
};

function tCritical(df: number): number {
  if (df <= 0) return Number.NaN;
  if (T95[df] !== undefined) return T95[df];
  const keys = Object.keys(T95)
    .map(Number)
    .sort((a, b) => a - b);
  for (const k of keys) if (df < k) return T95[k] as number;
  return 1.96;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). */
function stddev(xs: number[]): number {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Half-width of the 95% confidence interval of the mean. */
function ci95(xs: number[]): number {
  if (xs.length < 2) return Number.NaN;
  return (tCritical(xs.length - 1) * stddev(xs)) / Math.sqrt(xs.length);
}

interface Stats {
  n: number;
  median: number;
  mean: number;
  sd: number;
  ci: number;
  min: number;
  max: number;
  /** relative standard deviation, as a percentage of the mean */
  rsdPct: number;
}

function summarize(xs: number[]): Stats {
  const m = mean(xs);
  const sd = stddev(xs);
  return {
    n: xs.length,
    median: median(xs),
    mean: m,
    sd,
    ci: ci95(xs),
    min: Math.min(...xs),
    max: Math.max(...xs),
    rsdPct: (sd / m) * 100,
  };
}

// --- Formatting ---

/** Round to the nearest 100 req/s. Reporting finer than that is false precision. */
function rps(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return (Math.round(n / 100) * 100).toLocaleString("en-US");
}

function num(n: number, d = 1): string {
  if (!Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function pad(s: string, len: number, right = true): string {
  return right ? s + " ".repeat(Math.max(0, len - s.length)) : " ".repeat(Math.max(0, len - s.length)) + s;
}

// --- Process + readiness helpers ---

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not allocate a port"));
        return;
      }
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}

interface Child {
  kill: () => Promise<void>;
}

/** Loader flags this process was started with (tsx), reused for the child. */
function childExecArgv(): string[] {
  const argv = [...process.execArgv];
  const evalIdx = argv.indexOf("--eval");
  return evalIdx >= 0 ? argv.slice(0, evalIdx) : argv;
}

async function startServerProcess(fw: FrameworkDef, port: number): Promise<Child> {
  const child = spawn(process.execPath, [...childExecArgv(), RUNNER, fw.id, String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) {
      throw new Error(`${fw.label} server process exited before becoming ready.\n${stderr}`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`${fw.label} server did not become ready within 30s.\n${stderr}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        await res.arrayBuffer();
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    kill: () =>
      new Promise<void>((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        const force = setTimeout(() => child.kill("SIGKILL"), 3000);
        child.on("exit", () => {
          clearTimeout(force);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}

// --- Load generation ---

interface Sample {
  requestsPerSec: number;
  latencyP50: number;
  latencyP99: number;
  throughputMBps: number;
}

interface Violation {
  framework: string;
  scenario: string;
  rep: number;
  detail: string;
}

const violations: Violation[] = [];

function acOptions(baseUrl: string, s: Scenario, duration: number): autocannon.Options {
  const opts: autocannon.Options = {
    url: `${baseUrl}${s.path}`,
    connections: CONNECTIONS,
    duration,
    method: s.method,
  };
  if (s.body) opts.body = s.body;
  if (s.headers) opts.headers = s.headers;
  return opts;
}

function checkResult(fw: FrameworkDef, s: Scenario, rep: number, r: autocannon.Result): void {
  const total = r.requests.total;
  const non2xx = r.non2xx ?? 0;
  const ok2xx = (r as unknown as Record<string, number>)["2xx"] ?? 0;
  const problems: string[] = [];

  if (total === 0) problems.push("zero requests completed");
  if (r.errors > 0) problems.push(`errors=${r.errors}`);
  if (r.timeouts > 0) problems.push(`timeouts=${r.timeouts}`);

  if (s.expectNon2xx) {
    // Every response must be the intentional 500. A 2xx here means the server
    // is not exercising its error path.
    if (ok2xx > 0) problems.push(`expected only non-2xx, saw 2xx=${ok2xx}`);
    if (non2xx !== total) problems.push(`expected non2xx=${total}, got ${non2xx}`);
  } else if (non2xx > 0) {
    problems.push(`non2xx=${non2xx}`);
  }

  if (problems.length > 0) {
    violations.push({ framework: fw.label, scenario: s.name, rep, detail: problems.join(", ") });
  }
}

async function measure(fw: FrameworkDef, baseUrl: string, s: Scenario, rep: number): Promise<Sample> {
  // Discarded warmup pass on the exact endpoint we are about to measure.
  if (WARMUP > 0) await autocannon(acOptions(baseUrl, s, WARMUP));

  const r = await autocannon(acOptions(baseUrl, s, DURATION));
  checkResult(fw, s, rep, r);

  return {
    requestsPerSec: r.requests.average,
    latencyP50: r.latency.p50,
    latencyP99: r.latency.p99,
    throughputMBps: r.throughput.average / 1024 / 1024,
  };
}

// --- Orchestration ---

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/** samples[frameworkLabel][scenarioName] = one Sample per repetition */
type SampleStore = Map<string, Map<string, Sample[]>>;

function push(store: SampleStore, fw: string, scenario: string, sample: Sample): void {
  let byScenario = store.get(fw);
  if (!byScenario) {
    byScenario = new Map();
    store.set(fw, byScenario);
  }
  const list = byScenario.get(scenario);
  if (list) list.push(sample);
  else byScenario.set(scenario, [sample]);
}

function statsFor(store: SampleStore, fw: string, scenario: string): Stats | undefined {
  const samples = store.get(fw)?.get(scenario);
  if (!samples || samples.length === 0) return undefined;
  return summarize(samples.map((s) => s.requestsPerSec));
}

function latencyMedians(store: SampleStore, fw: string, scenario: string): { p50: number; p99: number } {
  const samples = store.get(fw)?.get(scenario) ?? [];
  return { p50: median(samples.map((s) => s.latencyP50)), p99: median(samples.map((s) => s.latencyP99)) };
}

// --- Reporting ---

function printTables(store: SampleStore, selected: FrameworkDef[]): void {
  console.log("\n===================================================");
  console.log("  COMPARATIVE BENCHMARK RESULTS");
  console.log(`  ${CONNECTIONS} connections, ${DURATION}s measured (+${WARMUP}s discarded warmup), n=${REPS}`);
  console.log("  req/s rounded to the nearest 100. CI = 95% confidence interval of the mean.");
  console.log("===================================================\n");

  for (const scenario of scenarios) {
    console.log(`### ${scenario.name}\n`);
    console.log("| Framework  | Median req/s |  +/- CI | SD (%) | Min .. Max          | p50 ms | p99 ms |");
    console.log("| ---------- | -----------: | ------: | -----: | ------------------- | -----: | -----: |");

    const rows = selected
      .map((fw) => ({ fw, st: statsFor(store, fw.label, scenario.name) }))
      .filter((r): r is { fw: FrameworkDef; st: Stats } => r.st !== undefined)
      .sort((a, b) => b.st.median - a.st.median);

    for (const { fw, st } of rows) {
      const lat = latencyMedians(store, fw.label, scenario.name);
      console.log(
        `| ${pad(fw.label, 10)} | ${pad(rps(st.median), 12, false)} | ${pad(rps(st.ci), 7, false)} | ${pad(num(st.rsdPct), 6, false)} | ${pad(`${rps(st.min)} .. ${rps(st.max)}`, 19, false)} | ${pad(num(lat.p50), 6, false)} | ${pad(num(lat.p99), 6, false)} |`,
      );
    }
    console.log("");
  }

  // Head-to-head vs Express, with an explicit overlap check.
  const celsian = selected.find((f) => f.id === "celsian");
  const express = selected.find((f) => f.id === "express");
  if (celsian && express) {
    console.log("### CelsianJS vs Express (per scenario)\n");
    console.log("| Scenario             |    Ratio | Verdict                       |");
    console.log("| -------------------- | -------: | ----------------------------- |");
    for (const s of scenarios) {
      const c = statsFor(store, celsian.label, s.name);
      const e = statsFor(store, express.label, s.name);
      if (!c || !e) continue;
      const ratio = c.median / e.median;
      const overlap = c.mean - c.ci <= e.mean + e.ci && e.mean - e.ci <= c.mean + c.ci;
      const verdict = overlap ? "inconclusive (CIs overlap)" : ratio > 1 ? "CelsianJS faster" : "Express faster";
      console.log(`| ${pad(s.name, 20)} | ${pad(`${num(ratio, 2)}x`, 8, false)} | ${pad(verdict, 29)} |`);
    }
    console.log("");
  }

  console.log("### Memory Usage\n");
  console.log("Measured separately (isolated process, absolute RSS). Run:");
  console.log(
    "  for fw in celsian express fastify hono; do NODE_OPTIONS=--expose-gc npx tsx benchmarks/mem.ts $fw; done\n",
  );
}

function printReliability(store: SampleStore, selected: FrameworkDef[], load: number[][]): void {
  console.log("### Measurement conditions\n");
  console.log(`  CPUs: ${os.cpus().length} (${os.cpus()[0]?.model ?? "unknown"})`);
  console.log(`  Load average at start: ${load[0]?.map((n) => n.toFixed(2)).join(", ")}`);
  console.log(`  Load average at end:   ${load[1]?.map((n) => n.toFixed(2)).join(", ")}`);

  let worst = 0;
  let unmeasurable = false;
  for (const fw of selected) {
    for (const s of scenarios) {
      const st = statsFor(store, fw.label, s.name);
      if (!st) continue;
      if (Number.isFinite(st.rsdPct)) worst = Math.max(worst, st.rsdPct);
      else unmeasurable = true;
    }
  }

  if (unmeasurable) {
    console.log("  Spread: NOT MEASURABLE (fewer than 2 repetitions per cell).");
    console.log("  VERDICT: a single pass proves nothing. Re-run with BENCH_REPS>=5 before quoting anything.\n");
    return;
  }

  console.log(`  Worst relative standard deviation across all cells: ${num(worst)}%`);
  if (worst > 10) {
    console.log("  VERDICT: spread is too wide. These numbers are NOT publishable as precise claims.");
  } else if (worst > 5) {
    console.log("  VERDICT: moderate spread. Only differences larger than ~15% should be claimed.");
  } else {
    console.log("  VERDICT: spread is tight enough to compare frameworks that differ by more than the CIs.");
  }
  console.log("");
}

// --- Main ---

async function main(): Promise<void> {
  const idxFlag = process.argv.indexOf("--frameworks");
  const wanted = idxFlag >= 0 ? (process.argv[idxFlag + 1] ?? "").split(",").filter(Boolean) : null;
  const selected = wanted ? allFrameworks.filter((f) => wanted.includes(f.id)) : allFrameworks;

  if (selected.length === 0) {
    console.error("No frameworks selected.");
    process.exit(2);
  }

  console.log(`Node.js ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Frameworks: ${selected.map((f) => f.label).join(", ")}`);
  console.log(`Connections: ${CONNECTIONS}, measured ${DURATION}s, warmup ${WARMUP}s, repetitions ${REPS}`);
  console.log("Each framework runs in its own child process; order is reshuffled every repetition.\n");

  const loadStart = os.loadavg();
  const store: SampleStore = new Map();

  for (let rep = 1; rep <= REPS; rep++) {
    const order = shuffle(selected);
    console.log(`--- repetition ${rep}/${REPS} (order: ${order.map((f) => f.label).join(" > ")}) ---`);

    for (const fw of order) {
      const port = await freePort();
      const child = await startServerProcess(fw, port);
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        for (const s of scenarios) {
          const sample = await measure(fw, baseUrl, s, rep);
          push(store, fw.label, s.name, sample);
          console.log(`  ${pad(fw.label, 10)} ${pad(s.name, 21)} ${pad(rps(sample.requestsPerSec), 8, false)} req/s`);
        }
      } finally {
        await child.kill();
        // Let the OS reclaim sockets before the next server binds.
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    console.log("");
  }

  const loadEnd = os.loadavg();

  printTables(store, selected);
  printReliability(store, selected, [loadStart, loadEnd]);

  if (violations.length > 0) {
    console.error("### RUN INVALID: failed HTTP results\n");
    for (const v of violations) {
      console.error(`  ${v.framework} / ${v.scenario} / rep ${v.rep}: ${v.detail}`);
    }
    console.error("\nEvery number above is untrustworthy. Fix the failures and re-run.");
    process.exit(1);
  }

  console.log("All autocannon results were clean (no errors, no timeouts, expected status codes).");
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
