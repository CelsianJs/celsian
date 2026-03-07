// benchmarks/run.ts — Comparative benchmark: CelsianJS vs Fastify vs Hono
//
// Usage: npx tsx benchmarks/run.ts
//        npx tsx benchmarks/run.ts --celsian-only

import autocannon from 'autocannon';
import { startBenchServer } from './server.js';
import { startFastifyServer } from './server-fastify.js';
import { startHonoServer } from './server-hono.js';

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
  { name: 'JSON hello', method: 'GET', path: '/json' },
  { name: 'Params', method: 'GET', path: '/users/42' },
  {
    name: 'Body parse',
    method: 'POST',
    path: '/echo',
    body: JSON.stringify({ name: 'benchmark', value: 12345, tags: ['perf', 'test'], nested: { ok: true } }),
    headers: { 'content-type': 'application/json' },
  },
  { name: 'Hooks chain', method: 'GET', path: '/hooks' },
  { name: 'Not found', method: 'GET', path: '/nonexistent' },
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
}

// ─── Helpers ───

function fmt(n: number, d = 0): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
}

function pad(s: string, len: number, right = true): string {
  return right ? s + ' '.repeat(Math.max(0, len - s.length)) : ' '.repeat(Math.max(0, len - s.length)) + s;
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
  const server = await startServer(port);
  await new Promise(r => setTimeout(r, 300));

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`  ${scenario.name}...`);
    const result = await runScenario(`http://127.0.0.1:${port}`, scenario);
    results.push(result);
    console.log(` ${fmt(result.requestsPerSec)} req/s`);
  }

  await server.close();
  // Give time for port to free
  await new Promise(r => setTimeout(r, 500));

  return { framework: name, results };
}

function printComparisonTable(all: FrameworkResults[]): void {
  console.log('\n## Comparative Benchmark Results\n');
  console.log(`${CONNECTIONS} connections, ${DURATION}s per scenario\n`);

  // Print per-scenario comparison
  for (const scenario of scenarios) {
    console.log(`### ${scenario.name}\n`);
    console.log(`| Framework    |      Req/s | P50 (ms) | P99 (ms) |`);
    console.log(`| ------------ | ---------- | -------- | -------- |`);

    const rows = all.map(fw => {
      const r = fw.results.find(r => r.name === scenario.name);
      if (!r) return null;
      return { fw: fw.framework, ...r };
    }).filter(Boolean) as { fw: string; requestsPerSec: number; latencyP50: number; latencyP99: number }[];

    // Sort by req/s descending
    rows.sort((a, b) => b.requestsPerSec - a.requestsPerSec);

    for (const r of rows) {
      console.log(`| ${pad(r.fw, 12)} | ${pad(fmt(r.requestsPerSec), 10, false)} | ${pad(fmt(r.latencyP50, 1), 8, false)} | ${pad(fmt(r.latencyP99, 1), 8, false)} |`);
    }
    console.log('');
  }

  // Summary table
  console.log('### Summary (JSON hello req/s)\n');
  const jsonResults = all.map(fw => ({
    fw: fw.framework,
    rps: fw.results.find(r => r.name === 'JSON hello')?.requestsPerSec ?? 0,
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

  const allResults: FrameworkResults[] = [];

  // CelsianJS
  allResults.push(await benchFramework('CelsianJS', startBenchServer, basePort));

  if (!celsianOnly) {
    // Fastify
    allResults.push(await benchFramework('Fastify', startFastifyServer, basePort + 1));

    // Hono
    allResults.push(await benchFramework('Hono', startHonoServer, basePort + 2));
  }

  printComparisonTable(allResults);

  // Force exit
  setTimeout(() => process.exit(0), 500);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
