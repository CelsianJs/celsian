// Run with: npx tsx --expose-gc benchmarks/memory-profile.ts
import { CelsianApp } from '../packages/core/src/app.js';

const app = new CelsianApp();
app.get('/json', (req, reply) => reply.json({ hello: 'world' }));
app.get('/users/:id', (req, reply) => reply.json({ id: req.params.id }));

// Measure baseline
const baseline = process.memoryUsage();
console.log('Baseline RSS:', (baseline.rss / 1024 / 1024).toFixed(1), 'MB');

// Send 10K requests using inject() (no HTTP overhead)
const start = Date.now();
for (let i = 0; i < 10000; i++) {
  await app.inject({ method: 'GET', url: '/json' });
}
const jsonTime = Date.now() - start;

// Force GC if exposed
if (global.gc) global.gc();

const afterJson = process.memoryUsage();
console.log('After 10K /json:', (afterJson.rss / 1024 / 1024).toFixed(1), 'MB');
console.log('  Heap used:', (afterJson.heapUsed / 1024 / 1024).toFixed(1), 'MB');
console.log('  Time:', jsonTime, 'ms');

// Send 10K param requests
const start2 = Date.now();
for (let i = 0; i < 10000; i++) {
  await app.inject({ method: 'GET', url: `/users/${i}` });
}
const paramTime = Date.now() - start2;

if (global.gc) global.gc();

const afterParams = process.memoryUsage();
console.log('After 10K /users/:id:', (afterParams.rss / 1024 / 1024).toFixed(1), 'MB');
console.log('  Heap used:', (afterParams.heapUsed / 1024 / 1024).toFixed(1), 'MB');
console.log('  Time:', paramTime, 'ms');

// Summary
console.log('\n--- Summary ---');
console.log('RSS growth:', ((afterParams.rss - baseline.rss) / 1024 / 1024).toFixed(1), 'MB');
console.log('Heap growth:', ((afterParams.heapUsed - baseline.heapUsed) / 1024 / 1024).toFixed(1), 'MB');
