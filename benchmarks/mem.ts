// benchmarks/mem.ts - Honest, isolated per-framework memory measurement.
//
// An older run.ts measured RSS *deltas* of a single shared process that hosted
// all servers sequentially, so whichever framework ran FIRST absorbed the entire
// one-time process warm-up (V8 heap growth, JIT, autocannon's connection pools)
// and looked ~50x heavier than the rest. That artifact made CelsianJS appear to
// use 94 to 100 MB vs an impossible "1.7 MB" for Express. run.ts no longer
// reports memory at all.
//
// This script runs ONE framework in a fresh process, drives real load against
// it, forces GC, then reports the process's ABSOLUTE RSS, which is the
// apples-to-apples number. Run each framework in its own process:
//
//   for fw in celsian express fastify hono; do
//     NODE_OPTIONS=--expose-gc npx tsx benchmarks/mem.ts $fw
//   done

import { spawn } from "node:child_process";
import { frameworks, getFramework } from "./frameworks.js";

const fw = process.argv[2] ?? "celsian";
const def = getFramework(fw);
if (!def) {
  console.error(`Unknown framework "${fw}". Use one of: ${frameworks.map((f) => f.id).join(", ")}`);
  process.exit(1);
}
const start = def.start;

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
