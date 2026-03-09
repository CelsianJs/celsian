// benchmarks/run.ts — Comparative benchmark: CelsianJS vs Express vs Fastify
//
// Usage: npx tsx benchmarks/run.ts
//        npx tsx benchmarks/run.ts --celsian-only

import autocannon from 'autocannon';
import { startBenchServer } from './server.js';
import { startFastifyServer } from './server-fastify.js';
import { startExpressServer } from './server-express.js';

// ─── Configuration ───

const CONNECTIONS = 10;
const DURATION = 10; // seconds

interface Scenario {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  headers?: Record<string, string>;
}

const scenarios: Scenario[] = [
  { name: 'JSON response', method: 'GET', path: '/json' },
  { name: 'Route params', method: 'GET', path: '/user/42' },
  { name: 'Middleware chain (5)', method: 'GET', path: '/middleware' },
  {
    name: 'JSON body parsing',
    method: 'POST',
    path: '/echo',
    body: JSON.stringify({ name: 'benchmark', value: 12345, tags: ['perf', 'test'], nested: { ok: true } }),
    headers: { 'content-type': 'application/json' },
  },
  { name: 'Error handling', method: 'GET', path: '/error' },
];

interface ScenarioResult {
  name: string;
  requestsPerSec: number;
  latencyP50: number;
  latencyP99: number;
  throughputMBps: number;
}

interface FrameworkResults {
  framework: string;
  results: ScenarioResult[];
  memoryMB: number;
}

// ─── Helpers ───

function fmt(n: number, d = 0): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
}

function pad(s: string, len: number, right = true): string {
  return right ? s + ' '.repeat(Math.max(0, len - s.length)) : ' '.repeat(Math.max(0, len - s.length)) + s;
}

function getMemoryMB(): number {
  return Math.round(process.memoryUsage.rss() / 1024 / 1024 * 10) / 10;
}

async function runScenario(baseUrl: string, scenario: Scenario): Promise<ScenarioResult> {
  const opts: autocannon.Options = {
    url: `${baseUrl}${scenario.path}`,
    connections: CONNECTIONS,
    duration: DURATION,
    method: scenario.method,
  };
  if (scenario.body) opts.body = scenario.body;
  if (scenario.headers) opts.headers = scenario.headers;

  const result = await autocannon(opts);

  return {
    name: scenario.name,
    requestsPerSec: result.requests.average,
    latencyP50: result.latency.p50,
    latencyP99: result.latency.p99,
    throughputMBps: result.throughput.average / 1024 / 1024,
  };
}

async function benchFramework(
  name: string,
  startServer: (port: number) => Promise<{ close: () => Promise<void> }>,
  port: number,
): Promise<FrameworkResults> {
  console.log(`\n─── ${name} ───`);
  // Force GC if available to get cleaner memory baseline
  if (global.gc) global.gc();
  const memBefore = getMemoryMB();
  const server = await startServer(port);
  await new Promise(r => setTimeout(r, 300));
  const memAfterStart = getMemoryMB();
  const memDeltaStartup = Math.round((memAfterStart - memBefore) * 10) / 10;

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`  ${scenario.name}...`);
    const result = await runScenario(`http://127.0.0.1:${port}`, scenario);
    results.push(result);
    console.log(` ${fmt(result.requestsPerSec)} req/s  (p50: ${fmt(result.latencyP50, 1)}ms, p99: ${fmt(result.latencyP99, 1)}ms)`);
  }

  const memAfterBench = getMemoryMB();
  const memDeltaTotal = Math.round((memAfterBench - memBefore) * 10) / 10;
  await server.close();
  await new Promise(r => setTimeout(r, 500));

  console.log(`  Memory delta: +${memDeltaStartup}MB (startup), +${memDeltaTotal}MB (after load)`);

  return { framework: name, results, memoryMB: memDeltaTotal };
}

function printComparisonTable(all: FrameworkResults[]): void {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  COMPARATIVE BENCHMARK RESULTS');
  console.log(`  ${CONNECTIONS} connections, ${DURATION}s per scenario`);
  console.log('═══════════════════════════════════════════════════\n');

  // Print per-scenario comparison
  for (const scenario of scenarios) {
    console.log(`### ${scenario.name}\n`);
    console.log(`| Framework    |      Req/s | P50 (ms) | P99 (ms) | Throughput |`);
    console.log(`| ------------ | ---------- | -------- | -------- | ---------- |`);

    const rows = all.map(fw => {
      const r = fw.results.find(r => r.name === scenario.name);
      if (!r) return null;
      return { fw: fw.framework, ...r };
    }).filter(Boolean) as (ScenarioResult & { fw: string })[];

    // Sort by req/s descending
    rows.sort((a, b) => b.requestsPerSec - a.requestsPerSec);

    for (const r of rows) {
      console.log(`| ${pad(r.fw, 12)} | ${pad(fmt(r.requestsPerSec), 10, false)} | ${pad(fmt(r.latencyP50, 1), 8, false)} | ${pad(fmt(r.latencyP99, 1), 8, false)} | ${pad(fmt(r.throughputMBps, 1) + ' MB/s', 10, false)} |`);
    }
    console.log('');
  }

  // Winner table
  console.log('### Winner Table\n');
  console.log(`| Scenario               | Winner       |      Req/s |`);
  console.log(`| ---------------------- | ------------ | ---------- |`);
  for (const scenario of scenarios) {
    const best = all
      .map(fw => ({ fw: fw.framework, rps: fw.results.find(r => r.name === scenario.name)?.requestsPerSec ?? 0 }))
      .sort((a, b) => b.rps - a.rps)[0]!;
    console.log(`| ${pad(scenario.name, 22)} | ${pad(best.fw, 12)} | ${pad(fmt(best.rps), 10, false)} |`);
  }
  console.log('');

  // Memory comparison
  console.log('### Memory Usage\n');
  console.log(`| Framework    | RSS (MB) |`);
  console.log(`| ------------ | -------- |`);
  for (const fw of all) {
    console.log(`| ${pad(fw.framework, 12)} | ${pad(fmt(fw.memoryMB, 1), 8, false)} |`);
  }
  console.log('');

  // Overall summary
  console.log('### Overall Summary (JSON response req/s)\n');
  const jsonResults = all.map(fw => ({
    fw: fw.framework,
    rps: fw.results.find(r => r.name === 'JSON response')?.requestsPerSec ?? 0,
  })).sort((a, b) => b.rps - a.rps);

  const fastest = jsonResults[0]!.rps;
  for (const r of jsonResults) {
    const pct = ((r.rps / fastest) * 100).toFixed(0);
    console.log(`  ${pad(r.fw, 12)}: ${pad(fmt(r.rps), 8, false)} req/s (${pct}%)`);
  }
  console.log('');
}

// ─── Main ───

async function main() {
  const celsianOnly = process.argv.includes('--celsian-only');
  const basePort = 10_000 + Math.floor(Math.random() * 40_000);

  console.log(`Node.js ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Connections: ${CONNECTIONS}, Duration: ${DURATION}s per scenario`);

  const allResults: FrameworkResults[] = [];

  // CelsianJS
  allResults.push(await benchFramework('CelsianJS', startBenchServer, basePort));

  if (!celsianOnly) {
    // Express
    allResults.push(await benchFramework('Express', startExpressServer, basePort + 1));

    // Fastify
    allResults.push(await benchFramework('Fastify', startFastifyServer, basePort + 2));
  }

  printComparisonTable(allResults);

  // Force exit
  setTimeout(() => process.exit(0), 500);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
