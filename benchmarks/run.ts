// benchmarks/run.ts — CelsianJS benchmark runner
//
// Starts a benchmark server, runs autocannon against each scenario,
// and prints a markdown results table to stdout.
//
// Usage: npx tsx benchmarks/run.ts

import autocannon from 'autocannon';
import { startBenchServer } from './server.js';

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
  {
    name: 'JSON hello',
    method: 'GET',
    path: '/json',
  },
  {
    name: 'Params',
    method: 'GET',
    path: '/users/42',
  },
  {
    name: 'Body parse',
    method: 'POST',
    path: '/echo',
    body: JSON.stringify({ name: 'benchmark', value: 12345, tags: ['perf', 'test'], nested: { ok: true } }),
    headers: { 'content-type': 'application/json' },
  },
  {
    name: 'Hooks chain',
    method: 'GET',
    path: '/hooks',
  },
  {
    name: 'Not found',
    method: 'GET',
    path: '/nonexistent',
  },
];

// ─── Result types ───

interface ScenarioResult {
  name: string;
  requestsPerSec: number;
  latencyP50: number;
  latencyP99: number;
  throughputMBps: number;
}

// ─── Helpers ───

function formatNum(n: number, decimals = 1): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function padRight(str: string, len: number): string {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

function padLeft(str: string, len: number): string {
  return ' '.repeat(Math.max(0, len - str.length)) + str;
}

async function runScenario(baseUrl: string, scenario: Scenario): Promise<ScenarioResult> {
  const url = `${baseUrl}${scenario.path}`;

  const opts: autocannon.Options = {
    url,
    connections: CONNECTIONS,
    duration: DURATION,
    method: scenario.method,
  };

  if (scenario.body) {
    opts.body = scenario.body;
  }

  if (scenario.headers) {
    opts.headers = scenario.headers;
  }

  const result = await autocannon(opts);

  return {
    name: scenario.name,
    requestsPerSec: result.requests.average,
    latencyP50: result.latency.p50,
    latencyP99: result.latency.p99,
    throughputMBps: result.throughput.average / 1024 / 1024,
  };
}

function printResultsTable(results: ScenarioResult[]): void {
  const COL = {
    name: 14,
    rps: 12,
    p50: 10,
    p99: 10,
    throughput: 14,
  };

  const header = [
    padRight('Scenario', COL.name),
    padLeft('Req/s', COL.rps),
    padLeft('P50 (ms)', COL.p50),
    padLeft('P99 (ms)', COL.p99),
    padLeft('Throughput', COL.throughput),
  ].join(' | ');

  const separator = [
    '-'.repeat(COL.name),
    '-'.repeat(COL.rps),
    '-'.repeat(COL.p50),
    '-'.repeat(COL.p99),
    '-'.repeat(COL.throughput),
  ].join(' | ');

  console.log('');
  console.log('## CelsianJS Benchmark Results');
  console.log('');
  console.log(`${CONNECTIONS} connections, ${DURATION}s per scenario`);
  console.log('');
  console.log(`| ${header} |`);
  console.log(`| ${separator} |`);

  for (const r of results) {
    const row = [
      padRight(r.name, COL.name),
      padLeft(formatNum(r.requestsPerSec, 0), COL.rps),
      padLeft(formatNum(r.latencyP50), COL.p50),
      padLeft(formatNum(r.latencyP99), COL.p99),
      padLeft(`${formatNum(r.throughputMBps, 2)} MB/s`, COL.throughput),
    ].join(' | ');

    console.log(`| ${row} |`);
  }

  console.log('');
}

// ─── Main ───

async function main() {
  // Pick a random high port to avoid conflicts
  const port = 10_000 + Math.floor(Math.random() * 50_000);
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Starting benchmark server on port ${port}...`);
  const server = await startBenchServer(port);

  // Give the server a moment to bind
  await new Promise((resolve) => setTimeout(resolve, 500));

  const results: ScenarioResult[] = [];

  try {
    for (const scenario of scenarios) {
      process.stdout.write(`  Running: ${scenario.name}...`);
      const result = await runScenario(baseUrl, scenario);
      results.push(result);
      console.log(` ${formatNum(result.requestsPerSec, 0)} req/s`);
    }

    printResultsTable(results);
  } finally {
    console.log('Shutting down benchmark server...');
    await server.close();

    // Force exit in case lingering timers/connections keep the process alive
    setTimeout(() => process.exit(0), 500);
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
