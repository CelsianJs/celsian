// Sustained-load soak: drive the Celsian server hard and sample its RSS over time.
// Flat/plateauing RSS = no leak; monotonic growth = leak.
import autocannon from "autocannon";
import { startBenchServer } from "./server.js";

const port = 14100;
const server = await startBenchServer(port);
const samples: number[] = [];
const timer = setInterval(() => {
  if (global.gc) global.gc();
  samples.push(Math.round((process.memoryUsage().rss / 1048576) * 10) / 10);
}, 4000);
// 40s of mixed load
const inst = autocannon({ url: `http://127.0.0.1:${port}/json`, connections: 25, duration: 40 });
await new Promise((res) => inst.on("done", res));
clearInterval(timer);
if (global.gc) {
  global.gc();
  global.gc();
}
samples.push(Math.round((process.memoryUsage().rss / 1048576) * 10) / 10);
console.log("RSS samples (MB, every 4s):", samples.join(" "));
const firstThird = samples.slice(0, Math.ceil(samples.length / 3));
const lastThird = samples.slice(-Math.ceil(samples.length / 3));
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const growth = avg(lastThird) - avg(firstThird);
console.log(
  `first-third avg: ${avg(firstThird).toFixed(1)}MB  last-third avg: ${avg(lastThird).toFixed(1)}MB  growth: ${growth.toFixed(1)}MB`,
);
console.log(growth < 10 ? "VERDICT: stable — no leak" : "VERDICT: RSS climbing — investigate");
await server.close();
process.exit(0);
