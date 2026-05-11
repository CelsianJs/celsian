#!/usr/bin/env node
import { spawn } from 'node:child_process';

const port = String(32000 + Math.floor(Math.random() * 10000));
const canSignalGroup = process.platform !== 'win32';
const child = spawn('npm', ['start'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: port, HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: canSignalGroup,
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(timeoutMs),
  ]);
}

function signalChild(signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    if (canSignalGroup && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

const deadline = Date.now() + 15_000;
let lastError;
let passed = false;
try {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`npm start exited with ${child.exitCode}\n${output}`);
    }
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      const body = await res.json().catch(() => null);
      if (res.status === 200 && body?.status === 'ok') {
        passed = true;
        break;
      }
      lastError = new Error(`unexpected health response ${res.status}: ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  if (!passed) {
    throw new Error(`health check timed out or failed: ${lastError?.message ?? 'unknown'}\n${output}`);
  }
} finally {
  signalChild('SIGTERM');
  await waitForExit(2_000);
  signalChild('SIGKILL');
  await waitForExit(1_000);
}
