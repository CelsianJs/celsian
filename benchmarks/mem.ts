// benchmarks/mem.ts — Honest, isolated per-framework memory measurement.
//
// run.ts measures RSS *deltas* of a single shared process that hosts all three
// servers sequentially, so whichever framework runs FIRST absorbs the entire
// one-time process warm-up (V8 heap growth, JIT, autocannon's connection pools)
// and looks ~50× heavier than the rest. That artifact made CelsianJS appear to
// use 94–100 MB vs an impossible "1.7 MB" for Express.
//
// This script runs ONE framework in a fresh process, drives real load against
// it, forces GC, then reports the process's ABSOLUTE RSS — an apples-to-apples
// number. Run each framework in its own process:
//
//   for fw in celsian express fastify; do
//     NODE_OPTIONS=--expose-gc npx tsx benchmarks/mem.ts $fw
//   done

import { spawn } from "node:child_process";
import { startBenchServer } from "./server.js";
import { startExpressServer } from "./server-express.js";
import { startFastifyServer } from "./server-fastify.js";

const starters: Record<string, (port: number) => Promise<{ close: () => Promise<void> }>> = {
  celsian: startBenchServer,
  express: startExpressServer,
  fastify: startFastifyServer,
};

const fw = process.argv[2] ?? "celsian";
const start = starters[fw];
if (!start) {
  console.error(`Unknown framework "${fw}". Use one of: ${Object.keys(starters).join(", ")}`);
  process.exit(1);
}

const port = 13000;
const server = await start(port);

// Drive steady-state load from a SEPARATE process (autocannon CLI) so the load
// generator's memory is not counted against the server. The RSS we report below
// is the server process alone.
await new Promise<void>((resolve, reject) => {
  const ac = spawn("npx", ["autocannon", "-c", "10", "-d", "8", `http://127.0.0.1:${port}/json`], {
    stdio: "ignore",
  });
  ac.on("exit", () => resolve());
  ac.on("error", reject);
});
await new Promise((r) => setTimeout(r, 200));

// Force GC (requires --expose-gc) so RSS reflects retained memory, not garbage.
const g = (globalThis as unknown as { gc?: () => void }).gc;
if (g) {
  g();
  g();
}
await new Promise((r) => setTimeout(r, 200));

const m = process.memoryUsage();
console.log(
  JSON.stringify({
    framework: fw,
    rssMB: Math.round((m.rss / 1024 / 1024) * 10) / 10,
    heapUsedMB: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
  }),
);

await server.close();
process.exit(0);
