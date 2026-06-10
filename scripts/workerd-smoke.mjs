// workerd smoke test (INF-03): boots scripts/workerd-smoke-worker.mjs in the
// real workerd runtime via `wrangler dev` (local mode) and asserts a 200 from
// the app. This verifies @celsian/core + @celsian/adapter-cloudflare actually
// run on Cloudflare's runtime, not just on Node.
//
// Usage: node scripts/workerd-smoke.mjs   (requires `pnpm build` first)
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.WORKERD_SMOKE_PORT ?? 8787);
const URL_ = `http://127.0.0.1:${PORT}/health`;
const BOOT_TIMEOUT_MS = 120_000;

// Pin the wrangler major so npx resolution is deterministic and cacheable.
const child = spawn(
  "npx",
  [
    "--yes",
    "wrangler@4",
    "dev",
    "scripts/workerd-smoke-worker.mjs",
    "--local",
    "--port",
    String(PORT),
    "--ip",
    "127.0.0.1",
    "--compatibility-date",
    "2025-05-01",
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  },
);

let output = "";
child.stdout.on("data", (d) => {
  output += d;
  process.stdout.write(d);
});
child.stderr.on("data", (d) => {
  output += d;
  process.stderr.write(d);
});

let exited = false;
child.on("exit", () => {
  exited = true;
});

function fail(message) {
  console.error(`\n[workerd-smoke] FAIL: ${message}`);
  child.kill("SIGTERM");
  process.exit(1);
}

const deadline = Date.now() + BOOT_TIMEOUT_MS;
let response;
while (Date.now() < deadline) {
  if (exited) fail(`wrangler dev exited early.\n--- output ---\n${output}`);
  try {
    response = await fetch(URL_);
    break;
  } catch {
    await sleep(1000);
  }
}

if (!response) fail(`server did not start within ${BOOT_TIMEOUT_MS / 1000}s`);
if (response.status !== 200) fail(`expected 200, got ${response.status}`);

const body = await response.json();
if (body.ok !== true || body.runtime !== "workerd") {
  fail(`unexpected body: ${JSON.stringify(body)}`);
}

console.log(`\n[workerd-smoke] PASS: ${response.status} ${JSON.stringify(body)}`);
child.kill("SIGTERM");
// Give wrangler a moment to shut down workerd, then force-exit.
await sleep(2000);
process.exit(0);
