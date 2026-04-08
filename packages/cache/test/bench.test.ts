// @celsian/cache — Performance Micro-benchmarks
// Measures KV store throughput, TTL overhead, response cache hit/miss, and session management.
// Thresholds are set conservatively for CI runners (~2x slower than local machines).

import { afterEach, describe, expect, it } from "vitest";
import { createResponseCache } from "../src/response-cache.js";
import { createSessionManager } from "../src/session.js";
import { MemoryKVStore } from "../src/store.js";

function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

function makeRequest(url: string, method = "GET"): Request {
  return new Request(`http://localhost${url}`, { method });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ─── MemoryKVStore Get/Set Throughput ───

describe("Bench: MemoryKVStore get/set", () => {
  let store: MemoryKVStore;

  afterEach(() => {
    store.destroy();
  });

  it("should measure set throughput (10000 ops)", async () => {
    store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const iterations = 10000;

    // Warm up
    for (let i = 0; i < 100; i++) {
      await store.set(`warmup-${i}`, { value: i });
    }
    await store.clear();

    const timings: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await store.set(`key-${i}`, { id: i, name: `item-${i}`, active: true });
      const end = performance.now();
      timings.push(end - start);
    }

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p99 = percentile(timings, 99);
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    const totalMs = timings.reduce((a, b) => a + b, 0);
    const opsPerSec = Math.round((iterations / totalMs) * 1000);

    console.log(`[MemoryKVStore set] ${iterations} ops`);
    console.log(`  avg: ${(avg * 1000).toFixed(2)} us`);
    console.log(`  p50: ${(p50 * 1000).toFixed(2)} us`);
    console.log(`  p99: ${(p99 * 1000).toFixed(2)} us`);
    console.log(`  ~${opsPerSec} ops/sec`);

    // Each set should be < 0.1ms on average (in-memory)
    expect(avg).toBeLessThan(0.1);
  });

  it("should measure get throughput (10000 ops)", async () => {
    store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const iterations = 10000;

    // Pre-populate store
    for (let i = 0; i < iterations; i++) {
      await store.set(`key-${i}`, { id: i, name: `item-${i}`, active: true });
    }

    // Warm up
    for (let i = 0; i < 100; i++) {
      await store.get(`key-${i}`);
    }

    const timings: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const val = await store.get(`key-${i}`);
      const end = performance.now();
      timings.push(end - start);
      expect(val).toBeDefined();
    }

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p99 = percentile(timings, 99);
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    const totalMs = timings.reduce((a, b) => a + b, 0);
    const opsPerSec = Math.round((iterations / totalMs) * 1000);

    console.log(`[MemoryKVStore get] ${iterations} ops`);
    console.log(`  avg: ${(avg * 1000).toFixed(2)} us`);
    console.log(`  p50: ${(p50 * 1000).toFixed(2)} us`);
    console.log(`  p99: ${(p99 * 1000).toFixed(2)} us`);
    console.log(`  ~${opsPerSec} ops/sec`);

    // Each get should be < 0.1ms on average (in-memory)
    expect(avg).toBeLessThan(0.1);
  });

  it("should measure mixed get/set throughput (10000 ops)", async () => {
    store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const iterations = 10000;

    // Pre-populate half
    for (let i = 0; i < iterations / 2; i++) {
      await store.set(`key-${i}`, { id: i });
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      if (i % 2 === 0) {
        await store.set(`key-${i}`, { id: i, updated: true });
      } else {
        await store.get(`key-${i}`);
      }
    }
    const elapsed = performance.now() - start;

    const opsPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[MemoryKVStore mixed get/set] ${iterations} ops`);
    console.log(`  ${iterations} ops in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${opsPerSec} ops/sec`);

    // Should handle at least 50k ops/sec for in-memory store (conservative for CI)
    expect(opsPerSec).toBeGreaterThan(50000);
  });
});

// ─── MemoryKVStore with TTL Throughput ───

describe("Bench: MemoryKVStore with TTL", () => {
  let store: MemoryKVStore;

  afterEach(() => {
    store.destroy();
  });

  it("should measure set-with-TTL throughput (10000 ops)", async () => {
    store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const iterations = 10000;

    // Warm up
    for (let i = 0; i < 100; i++) {
      await store.set(`warmup-${i}`, i, 60000);
    }
    await store.clear();

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await store.set(`ttl-key-${i}`, { id: i, data: `value-${i}` }, 60000);
    }
    const elapsed = performance.now() - start;

    const opsPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[MemoryKVStore set with TTL] ${iterations} ops`);
    console.log(`  ${iterations} ops in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${opsPerSec} ops/sec`);

    // TTL should add minimal overhead (conservative for CI)
    expect(opsPerSec).toBeGreaterThan(50000);
  });

  it("should measure get-with-TTL-check throughput (10000 ops)", async () => {
    store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const iterations = 10000;

    // Pre-populate with TTL entries
    for (let i = 0; i < iterations; i++) {
      await store.set(`ttl-key-${i}`, { id: i }, 60000);
    }

    // Warm up
    for (let i = 0; i < 100; i++) {
      await store.get(`ttl-key-${i}`);
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await store.get(`ttl-key-${i}`);
    }
    const elapsed = performance.now() - start;

    const opsPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[MemoryKVStore get with TTL check] ${iterations} ops`);
    console.log(`  ${iterations} ops in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${opsPerSec} ops/sec`);

    // TTL check should add minimal overhead to get (conservative for CI)
    expect(opsPerSec).toBeGreaterThan(50000);
  });

  it("should measure TTL expiration check overhead", async () => {
    store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const iterations = 10000;

    // Measure get for non-TTL entries
    for (let i = 0; i < iterations; i++) {
      await store.set(`no-ttl-${i}`, { id: i });
    }

    const startNoTTL = performance.now();
    for (let i = 0; i < iterations; i++) {
      await store.get(`no-ttl-${i}`);
    }
    const elapsedNoTTL = performance.now() - startNoTTL;

    await store.clear();

    // Measure get for TTL entries
    for (let i = 0; i < iterations; i++) {
      await store.set(`with-ttl-${i}`, { id: i }, 60000);
    }

    const startWithTTL = performance.now();
    for (let i = 0; i < iterations; i++) {
      await store.get(`with-ttl-${i}`);
    }
    const elapsedWithTTL = performance.now() - startWithTTL;

    const overhead = ((elapsedWithTTL - elapsedNoTTL) / elapsedNoTTL) * 100;

    console.log(`[MemoryKVStore TTL overhead]`);
    console.log(`  without TTL: ${elapsedNoTTL.toFixed(1)} ms for ${iterations} gets`);
    console.log(`  with TTL:    ${elapsedWithTTL.toFixed(1)} ms for ${iterations} gets`);
    console.log(`  overhead:    ${overhead.toFixed(1)}%`);

    // TTL check overhead should be < 500% (generous for CI microtiming variance)
    expect(overhead).toBeLessThan(500);
  });
});

// ─── Response Cache Hit/Miss Throughput ───

describe("Bench: Response Cache hit/miss", () => {
  it("should measure cache miss throughput", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });
    const iterations = 5000;

    const handler = () => jsonResponse({ ok: true });

    // Warm up
    for (let i = 0; i < 50; i++) {
      await cache.cached(makeRequest(`/warmup-${i}`), handler);
    }
    await store.clear();

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      // Each unique URL is a cache miss
      await cache.cached(makeRequest(`/miss-${i}`), handler);
    }
    const elapsed = performance.now() - start;

    const reqPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[Response cache MISS] ${iterations} requests`);
    console.log(`  ${iterations} requests in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${reqPerSec} req/sec`);

    // Should handle at least 2k miss/sec (handler + cache write, conservative for CI)
    expect(reqPerSec).toBeGreaterThan(2000);

    store.destroy();
  });

  it("should measure cache hit throughput", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });
    const iterations = 10000;

    const handler = () => jsonResponse({ ok: true });

    // Pre-populate cache
    await cache.cached(makeRequest("/data"), handler);

    // Warm up
    for (let i = 0; i < 100; i++) {
      await cache.cached(makeRequest("/data"), handler);
    }

    const timings: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const res = await cache.cached(makeRequest("/data"), handler);
      const end = performance.now();
      timings.push(end - start);
      expect(res.headers.get("x-cache")).toBe("HIT");
    }

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p99 = percentile(timings, 99);
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    const totalMs = timings.reduce((a, b) => a + b, 0);
    const reqPerSec = Math.round((iterations / totalMs) * 1000);

    console.log(`[Response cache HIT] ${iterations} requests`);
    console.log(`  avg: ${(avg * 1000).toFixed(2)} us`);
    console.log(`  p50: ${(p50 * 1000).toFixed(2)} us`);
    console.log(`  p99: ${(p99 * 1000).toFixed(2)} us`);
    console.log(`  ~${reqPerSec} req/sec`);

    // Cache hits should be fast — at least 5k req/sec (conservative for CI)
    expect(reqPerSec).toBeGreaterThan(5000);

    store.destroy();
  });

  it("should measure wrap() handler throughput (mixed hit/miss)", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });
    const iterations = 5000;
    const uniqueRoutes = 100;

    let handlerCalls = 0;
    const handler = (_req: Request) => {
      handlerCalls++;
      return jsonResponse({ n: handlerCalls });
    };

    const wrapped = cache.wrap(handler);

    // Warm up
    for (let i = 0; i < uniqueRoutes; i++) {
      await wrapped(makeRequest(`/route-${i}`));
    }
    handlerCalls = 0;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await wrapped(makeRequest(`/route-${i % uniqueRoutes}`));
    }
    const elapsed = performance.now() - start;

    const reqPerSec = Math.round((iterations / elapsed) * 1000);
    const hitRate = (((iterations - handlerCalls) / iterations) * 100).toFixed(1);

    console.log(`[Response cache wrap() mixed] ${iterations} requests`);
    console.log(`  ${iterations} requests in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${reqPerSec} req/sec`);
    console.log(`  hit rate: ${hitRate}%`);
    console.log(`  handler invocations: ${handlerCalls}`);

    // All should be hits (100 unique routes, all pre-populated)
    expect(handlerCalls).toBe(0);
    expect(reqPerSec).toBeGreaterThan(5000);

    store.destroy();
  });
});

// ─── Session Create/Load Throughput ───

describe("Bench: Session create/load", () => {
  it("should measure session create throughput", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const sessions = createSessionManager({ store });
    const iterations = 5000;

    // Warm up
    for (let i = 0; i < 50; i++) {
      await sessions.create();
    }
    await store.clear();

    const start = performance.now();
    const sessionIds: string[] = [];
    for (let i = 0; i < iterations; i++) {
      const session = await sessions.create({ userId: i, role: "user" });
      sessionIds.push(session.id);
    }
    const elapsed = performance.now() - start;

    const reqPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[Session create] ${iterations} sessions`);
    console.log(`  ${iterations} sessions in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${reqPerSec} sessions/sec`);

    // Should create at least 5k sessions/sec (conservative for CI)
    expect(reqPerSec).toBeGreaterThan(5000);
    // Verify all IDs are unique
    expect(new Set(sessionIds).size).toBe(iterations);

    store.destroy();
  });

  it("should measure session load throughput", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const sessions = createSessionManager({ store });
    const iterations = 5000;

    // Pre-create sessions
    const sessionIds: string[] = [];
    for (let i = 0; i < iterations; i++) {
      const session = await sessions.create({ userId: i, role: "user" });
      sessionIds.push(session.id);
    }

    // Warm up
    for (let i = 0; i < 50; i++) {
      await sessions.load(sessionIds[i]!);
    }

    const timings: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const session = await sessions.load(sessionIds[i]!);
      const end = performance.now();
      timings.push(end - start);
      expect(session).toBeDefined();
      expect(session?.get("userId")).toBe(i);
    }

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p99 = percentile(timings, 99);
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    const totalMs = timings.reduce((a, b) => a + b, 0);
    const reqPerSec = Math.round((iterations / totalMs) * 1000);

    console.log(`[Session load] ${iterations} loads`);
    console.log(`  avg: ${(avg * 1000).toFixed(2)} us`);
    console.log(`  p50: ${(p50 * 1000).toFixed(2)} us`);
    console.log(`  p99: ${(p99 * 1000).toFixed(2)} us`);
    console.log(`  ~${reqPerSec} loads/sec`);

    // Should load at least 20k sessions/sec from memory (conservative for CI)
    expect(reqPerSec).toBeGreaterThan(20000);

    store.destroy();
  });

  it("should measure session create + set + save + load round-trip", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const sessions = createSessionManager({ store });
    const iterations = 2000;

    // Warm up
    for (let i = 0; i < 20; i++) {
      const s = await sessions.create();
      s.set("data", i);
      await s.save();
      await sessions.load(s.id);
    }
    await store.clear();

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const session = await sessions.create();
      session.set("userId", i);
      session.set("role", "admin");
      session.set("preferences", { theme: "dark", lang: "en" });
      await session.save();

      const loaded = await sessions.load(session.id);
      expect(loaded).toBeDefined();
      expect(loaded?.get("userId")).toBe(i);
    }
    const elapsed = performance.now() - start;

    const reqPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[Session full round-trip] ${iterations} iterations`);
    console.log(`  ${iterations} round-trips in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${reqPerSec} round-trips/sec`);

    // Should handle at least 2k full round-trips/sec (conservative for CI)
    expect(reqPerSec).toBeGreaterThan(2000);

    store.destroy();
  });

  it("should measure fromRequest throughput (cookie parsing + load)", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const sessions = createSessionManager({ store });
    const iterations = 5000;

    // Pre-create sessions
    const sessionIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const session = await sessions.create({ userId: i });
      sessionIds.push(session.id);
    }

    // Warm up
    for (let i = 0; i < 50; i++) {
      const request = new Request("http://localhost/profile", {
        headers: { cookie: `sid=${sessionIds[i % 100]}; other=value` },
      });
      await sessions.fromRequest(request);
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const request = new Request("http://localhost/profile", {
        headers: { cookie: `sid=${sessionIds[i % 100]}; theme=dark; lang=en` },
      });
      await sessions.fromRequest(request);
    }
    const elapsed = performance.now() - start;

    const reqPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`[Session fromRequest] ${iterations} requests`);
    console.log(`  ${iterations} requests in ${elapsed.toFixed(1)} ms`);
    console.log(`  ~${reqPerSec} req/sec`);

    // Should handle at least 5k fromRequest/sec (conservative for CI)
    expect(reqPerSec).toBeGreaterThan(5000);

    store.destroy();
  });
});
