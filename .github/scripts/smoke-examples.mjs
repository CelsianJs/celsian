#!/usr/bin/env node
// .github/scripts/smoke-examples.mjs - boot every runnable example, probe it, report.
//
// Nothing in CI covered `examples/` before this script existed. That is how the
// flagship `showcase` example shipped with a cron expression that threw on
// startup: it had never been started, by anyone, in CI or out.
//
// For each example that can run on plain Node, this boots it on a random free
// port, waits for the port to answer, and then requires a specific known-good
// endpoint to return a specific status. Examples that target another platform
// (Lambda, Workers, Vercel) cannot be booted this way; they are listed
// explicitly in NON_BOOTABLE with the reason, so the set of things NOT covered
// stays visible instead of silently shrinking.
//
// Exit code is non-zero if any bootable example fails to serve its endpoint.

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

// A known-good endpoint per example, and the status a WORKING example returns.
//
// The previous version probed `/health`, `/healthz`, `/` in order and accepted
// ANY HTTP answer, 404 included, on the reasoning that a 404 still proves the
// server booted. It does, and that is all it proves: `auth-flow`, `rest-api`
// and `rpc-api` all passed this gate on 404s. A gate that a completely broken
// example passes is not a gate.
//
// Every bootable example must therefore name an endpoint it is supposed to
// serve and the status it is supposed to answer with. An example with no entry
// here fails rather than falling back to something permissive: adding an
// example should mean deciding what "working" means for it.
const PROBES = {
  "auth-flow": { path: "/health", expect: 200 },
  basic: { path: "/health", expect: 200 },
  "crud-api": { path: "/todos", expect: 200 },
  quickstart: { path: "/todos", expect: 200 },
  "rest-api": { path: "/users", expect: 200 },
  "rpc-api": { path: '/_rpc/greeting.hello?input={"name":"smoke"}', expect: 200 },
  "saas-demo": { path: "/health", expect: 200 },
  showcase: { path: "/health", expect: 200 },
};

// Polled first, purely to detect that the port is listening. Its status is
// never used as a pass signal.
const LIVENESS_PATH = "/";

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

/** True once the port answers anything at all. Liveness, not correctness. */
async function isListening(port) {
  try {
    await fetch(`http://127.0.0.1:${port}${LIVENESS_PATH}`, {
      signal: AbortSignal.timeout(2000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Hit the example's known-good endpoint and report whether it answered as promised. */
async function probe(port, probeSpec) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${probeSpec.path}`, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
    const body = await res.text();
    return { status: res.status, body: body.slice(0, 500) };
  } catch (error) {
    return { status: 0, body: String(error?.message ?? error) };
  }
}

async function smokeOne(name) {
  const dir = join(examplesDir, name);
  const pkg = readPackageJson(dir);
  if (!pkg) {
    // No package.json at all: a stray directory (a leftover node_modules, a
    // scratch dir), not an example. Reported so it stays visible.
    return { name, ok: true, skipped: true, reason: "no package.json, not an example" };
  }
  const script = pickScript(pkg);
  if (!script) {
    return { name, ok: false, reason: "no `start` or `dev` script to boot" };
  }

  const probeSpec = PROBES[name];
  if (!probeSpec) {
    return {
      name,
      ok: false,
      reason: `no PROBES entry: add a known-good endpoint and expected status to ${"smoke-examples.mjs"}`,
    };
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
    let listening = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null && child.exitCode !== 0) {
        return { name, ok: false, reason: `process exited with ${child.exitCode}`, output };
      }
      if (await isListening(port)) {
        listening = true;
        break;
      }
      await sleep(300);
    }
    if (!listening) {
      return { name, ok: false, reason: `no HTTP response within ${BOOT_TIMEOUT_MS / 1000}s`, output };
    }

    const hit = await probe(port, probeSpec);
    if (hit.status !== probeSpec.expect) {
      return {
        name,
        ok: false,
        reason: `${probeSpec.path} -> ${hit.status || "no response"}, expected ${probeSpec.expect}`,
        output: `${output}\n--- response body ---\n${hit.body}`,
      };
    }
    return { name, ok: true, reason: `${probeSpec.path} -> ${hit.status}` };
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
    console.log(result.skipped ? `skipped (${result.reason})` : result.ok ? `ok (${result.reason})` : `FAILED (${result.reason})`);
    if (result.skipped) continue;
    if (!result.ok && result.output) {
      console.log(`--- ${name} output ---\n${result.output.slice(-4000)}\n--- end ---`);
    }
    results.push(result);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} examples served their known-good endpoint.`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
