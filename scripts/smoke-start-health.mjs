#!/usr/bin/env node
import { spawn } from 'node:child_process';

const port = String(32000 + Math.floor(Math.random() * 10000));
const child = spawn('npm', ['start'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: port, HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!passed) {
    throw new Error(`health check timed out or failed: ${lastError?.message ?? 'unknown'}\n${output}`);
  }
} finally {
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 2000).unref();
}
