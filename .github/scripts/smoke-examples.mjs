#!/usr/bin/env node
// .github/scripts/smoke-examples.mjs - boot every runnable example, probe it, report.
//
// Nothing in CI covered `examples/` before this script existed. That is how the
// flagship `showcase` example shipped with a cron expression that threw on
// startup: it had never been started, by anyone, in CI or out.
//
// For each example that can run on plain Node, this boots it on a random free
// port and polls an endpoint until it answers or the deadline passes. Examples
// that target another platform (Lambda, Workers, Vercel) cannot be booted this
// way; they are listed explicitly in NON_BOOTABLE with the reason, so the set
// of things NOT covered stays visible instead of silently shrinking.
//
// Exit code is non-zero if any bootable example fails to serve.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const examplesDir = join(repoRoot, "examples");

// Examples that are not plain Node servers. Each entry says why, so this list
// is a statement about the platform, not a place to hide a broken example.
const NON_BOOTABLE = {
  "aws-lambda": "Lambda handler; needs SAM/API Gateway to invoke",
  "cloudflare-worker": "Workers runtime; covered by the test-workerd job",
  "vercel-edge": "Vercel Edge runtime; no local server entrypoint",
  "vercel-serverless": "Vercel serverless functions; needs `vercel dev`",
  docker: "container image; boots via docker compose, not `npm start`",
};

// Endpoints to try, in order. Examples do not all expose /health.
const PROBE_PATHS = ["/health", "/healthz", "/"];

const BOOT_TIMEOUT_MS = 30_000;
const canSignalGroup = process.platform !== "win32";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPackageJson(dir) {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Pick the script to boot with.
 *
 * `dev` is preferred over `start` because it is what every example README tells
 * a reader to run, and it runs from source. Several examples define `start` as
 * `node dist/index.js`, which needs a separate build first and fails outright
 * from a clean checkout. Testing the command we actually document is the point.
 */
function pickScript(pkg) {
  const scripts = pkg?.scripts ?? {};
  // `dev` is often a watcher (tsx watch). It still serves, which is all we need.
  if (scripts.dev) return "dev";
  if (scripts.start) return "start";
  return null;
}

async function probe(port) {
  for (const path of PROBE_PATHS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(2000),
      });
      // Any HTTP answer proves the server booted and is routing. A 404 on `/`
      // is a perfectly healthy server that simply has no root route.
      if (res.status > 0) return { path, status: res.status };
    } catch {
      // try the next path
    }
  }
  return null;
}

async function smokeOne(name) {
  const dir = join(examplesDir, name);
  const pkg = readPackageJson(dir);
  const script = pickScript(pkg);
  if (!script) {
    return { name, ok: false, reason: "no `start` or `dev` script to boot" };
  }

  const port = String(32000 + Math.floor(Math.random() * 10000));
  const child = spawn("npm", ["run", script], {
    cwd: dir,
    env: { ...process.env, PORT: port, HOST: "127.0.0.1", NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: canSignalGroup,
  });

  let output = "";
  child.stdout.on("data", (c) => {
    output += c;
  });
  child.stderr.on("data", (c) => {
    output += c;
  });

  const signalChild = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (canSignalGroup && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null && child.exitCode !== 0) {
        return { name, ok: false, reason: `process exited with ${child.exitCode}`, output };
      }
      const hit = await probe(port);
      if (hit) {
        return { name, ok: true, reason: `${hit.path} -> ${hit.status}` };
      }
      await sleep(300);
    }
    return { name, ok: false, reason: `no HTTP response within ${BOOT_TIMEOUT_MS / 1000}s`, output };
  } finally {
    signalChild("SIGTERM");
    await sleep(500);
    signalChild("SIGKILL");
  }
}

async function main() {
  const names = readdirSync(examplesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const results = [];
  for (const name of names) {
    if (NON_BOOTABLE[name]) {
      console.log(`SKIP  ${name}: ${NON_BOOTABLE[name]}`);
      continue;
    }
    process.stdout.write(`BOOT  ${name} ... `);
    const result = await smokeOne(name);
    console.log(result.ok ? `ok (${result.reason})` : `FAILED (${result.reason})`);
    if (!result.ok && result.output) {
      console.log(`--- ${name} output ---\n${result.output.slice(-4000)}\n--- end ---`);
    }
    results.push(result);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} examples booted and served.`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
