// @celsian/rate-limit — trust boundary, eviction fairness, key bounds, Redis store

import { CelsianError, createApp } from "@celsian/core";
import { describe, expect, it, vi } from "vitest";
import {
  createRedisRateLimitStore,
  ipInCidr,
  MemoryRateLimitStore,
  parseCidr,
  parseIp,
  type RateLimitOptions,
  type RedisRateLimitClient,
  rateLimit,
} from "../src/index.js";

async function buildApp(options: RateLimitOptions) {
  const app = createApp();
  await app.register(rateLimit(options), { encapsulate: false });
  app.get("/api", (_req, reply) => reply.json({ ok: true }));
  return app;
}

/** Count how many of `n` requests were blocked with 429. */
async function countBlocked(
  app: Awaited<ReturnType<typeof buildApp>>,
  n: number,
  headers: (i: number) => Record<string, string>,
): Promise<number> {
  let blocked = 0;
  for (let i = 0; i < n; i++) {
    const response = await app.inject({ url: "/api", headers: headers(i) });
    if (response.status === 429) blocked++;
  }
  return blocked;
}

describe("trustedProxies declares a real trust boundary (H-8)", () => {
  it("keys on the rightmost entry that is NOT one of our proxies", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustedProxies: ["10.0.0.0/8"] });

    // The client sent `1.1.1.1` themselves; our proxies appended 10.0.0.7 then
    // 10.0.0.8. The real client as seen by the outermost proxy is 203.0.113.5.
    const blocked = await countBlocked(app, 20, () => ({
      "x-forwarded-for": "1.1.1.1, 203.0.113.5, 10.0.0.7, 10.0.0.8",
    }));
    expect(blocked).toBe(17);
  });

  it("SECURITY: rotating the spoofable prefix cannot mint a fresh bucket", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustedProxies: ["10.0.0.0/8"] });

    // The proven bypass shape: 50 requests, a different forged IP each time.
    // Everything left of our own proxies is attacker-supplied and must be ignored.
    const blocked = await countBlocked(app, 50, (i) => ({
      "x-forwarded-for": `9.9.9.${i % 256}, 203.0.113.5, 10.0.0.7`,
    }));
    expect(blocked).toBe(47);
  });

  it("falls back to one shared bucket when every entry is one of our own proxies", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustedProxies: ["10.0.0.0/8"] });
    const blocked = await countBlocked(app, 10, () => ({ "x-forwarded-for": "10.0.0.7, 10.0.0.8" }));
    expect(blocked).toBe(7);
  });

  it("recognizes IPv6 proxies via a CIDR block", async () => {
    const app = await buildApp({ max: 2, window: 60_000, trustedProxies: ["2001:db8::/32"] });
    // The two rightmost entries are our IPv6 proxies, so the client is the
    // fixed 203.0.113.5 and the rotating attacker prefix is ignored.
    const blocked = await countBlocked(app, 10, (i) => ({
      "x-forwarded-for": `dead::${i}, 203.0.113.5, 2001:db8::1, 2001:db8:ffff::2`,
    }));
    expect(blocked).toBe(8);
  });

  it("rejects an empty or malformed trustedProxies list at registration", () => {
    expect(() => rateLimit({ max: 1, window: 1000, trustedProxies: [] })).toThrow(CelsianError);
    expect(() => rateLimit({ max: 1, window: 1000, trustedProxies: ["not-an-ip"] })).toThrow(CelsianError);
    expect(() => rateLimit({ max: 1, window: 1000, trustedProxies: ["10.0.0.0/99"] })).toThrow(CelsianError);
  });

  it("names keyGenerator first in the failure message when no trust boundary is declared", () => {
    expect(() => rateLimit({ max: 1, window: 1000 })).toThrow(/keyGenerator/);
  });
});

describe("X-Real-IP is never a silent fallback (M-5/M-6)", () => {
  it("SECURITY: rotating X-Real-IP does not bypass the limit by default", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustedProxies: ["10.0.0.0/8"] });
    // Previously 0/20 were blocked: the client fully controlled its bucket key.
    const blocked = await countBlocked(app, 20, (i) => ({ "x-real-ip": `9.9.9.${i}` }));
    expect(blocked).toBe(17);
  });

  it("SECURITY: X-Real-IP cannot be used to burn a victim's bucket by default", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustedProxies: ["10.0.0.0/8"] });

    // Attacker floods claiming to be the victim.
    await countBlocked(app, 10, () => ({ "x-real-ip": "203.0.113.99" }));

    // The victim (identified through the verified XFF chain) is unaffected.
    const victim = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "203.0.113.99, 10.0.0.7" },
    });
    expect(victim.status).toBe(200);
    expect(victim.headers.get("x-ratelimit-remaining")).toBe("2");
  });

  it("uses X-Real-IP only when the deployment declares it trusted", async () => {
    const app = await buildApp({
      max: 3,
      window: 60_000,
      trustedProxies: ["10.0.0.0/8"],
      trustXRealIp: true,
    });
    const blocked = await countBlocked(app, 20, (i) => ({ "x-real-ip": `9.9.9.${i}` }));
    expect(blocked).toBe(0);
  });

  it("hop-count mode no longer falls back to X-Real-IP either", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustProxy: true });
    const blocked = await countBlocked(app, 20, (i) => ({ "x-real-ip": `9.9.9.${i}` }));
    expect(blocked).toBe(17);
  });
});

describe("key length is bounded", () => {
  it("collapses an over-long key into one shared bucket instead of storing it verbatim", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustedProxies: ["10.0.0.0/8"], trustXRealIp: true });

    // A 20,000-character X-Real-IP, different every time. Stored verbatim
    // against the 100k-key cap this is gigabytes of retained memory.
    const blocked = await countBlocked(app, 20, (i) => ({ "x-real-ip": `${i}`.padEnd(20_000, "9") }));
    expect(blocked).toBe(17);
  });

  it("does not collapse normal-length keys", async () => {
    const app = await buildApp({ max: 3, window: 60_000, keyGenerator: (req) => req.headers.get("x-api-key") ?? "k" });
    const blocked = await countBlocked(app, 20, (i) => ({ "x-api-key": `key-${i}` }));
    expect(blocked).toBe(0);
  });

  it("rejects an invalid maxKeyLength at registration", () => {
    expect(() => rateLimit({ max: 1, window: 1000, keyGenerator: () => "k", maxKeyLength: 0 })).toThrow(CelsianError);
    expect(() => rateLimit({ max: 1, window: 1000, keyGenerator: () => "k", maxKeyLength: 1.5 })).toThrow(CelsianError);
  });
});

describe("eviction does not punish the victim", () => {
  it("evicts the flood's own count-1 entries, not the established client", async () => {
    const onCapReached = vi.fn();
    const store = new MemoryRateLimitStore({ maxKeys: 4, onCapReached });

    // An established client with a real counter.
    await store.increment("victim", 60_000);
    await store.increment("victim", 60_000);
    const before = await store.increment("victim", 60_000);
    expect(before.count).toBe(3);

    // A flood of fresh single-hit keys.
    for (let i = 0; i < 50; i++) {
      await store.increment(`flood-${i}`, 60_000);
    }

    // Insertion-order eviction reset the victim's counter to 1. Count-ordered
    // eviction keeps the entry that is actually being throttled.
    const after = await store.increment("victim", 60_000);
    expect(after.count).toBe(4);
    store.destroy();
  });

  it("warns exactly once when the key cap is first hit", async () => {
    const onCapReached = vi.fn();
    const store = new MemoryRateLimitStore({ maxKeys: 2, onCapReached });
    for (let i = 0; i < 10; i++) await store.increment(`k-${i}`, 60_000);
    expect(onCapReached).toHaveBeenCalledTimes(1);
    expect(onCapReached).toHaveBeenCalledWith(2);
    store.destroy();
  });

  it("still prefers an expired entry over a live one", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryRateLimitStore({ maxKeys: 2 });
      await store.increment("short", 1_000);
      await store.increment("long", 60_000);
      await store.increment("long", 60_000);

      vi.advanceTimersByTime(2_000);
      await store.increment("newcomer", 60_000);

      // `long` survived: `short` had expired and was evicted first.
      expect((await store.increment("long", 60_000)).count).toBe(3);
      store.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Retry-After", () => {
  it("is never 0 even when the window is about to roll over", async () => {
    const app = await buildApp({ max: 1, window: 1, keyGenerator: () => "k" });

    await app.inject({ url: "/api" });
    // With a 1 ms window the reset time is already in the past by the time the
    // second request is handled, so the raw computation yields 0 or negative.
    for (let i = 0; i < 5; i++) {
      const response = await app.inject({ url: "/api" });
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect((await response.json()).retryAfter).toBeGreaterThanOrEqual(1);
        return;
      }
    }
  });
});

describe("Redis store", () => {
  /** Minimal in-process stand-in that executes the same semantics as the Lua script. */
  function fakeRedis(): RedisRateLimitClient & { counters: Map<string, { count: number; expiresAt: number }> } {
    const counters = new Map<string, { count: number; expiresAt: number }>();
    return {
      counters,
      async eval(_script, _numKeys, ...args) {
        const key = String(args[0]);
        const window = Number(args[1]);
        const now = Date.now();
        const existing = counters.get(key);
        if (!existing || existing.expiresAt <= now) {
          counters.set(key, { count: 1, expiresAt: now + window });
          return [1, window];
        }
        existing.count++;
        return [existing.count, existing.expiresAt - now];
      },
    };
  }

  it("increments and expires through the injected client", async () => {
    const client = fakeRedis();
    const store = createRedisRateLimitStore({ client, prefix: "test:" });

    expect((await store.increment("ip", 60_000)).count).toBe(1);
    expect((await store.increment("ip", 60_000)).count).toBe(2);
    expect(client.counters.has("test:ip")).toBe(true);
  });

  it("shares one counter across app instances", async () => {
    const client = fakeRedis();
    const appA = await buildApp({
      max: 3,
      window: 60_000,
      keyGenerator: () => "shared",
      store: createRedisRateLimitStore({ client }),
    });
    const appB = await buildApp({
      max: 3,
      window: 60_000,
      keyGenerator: () => "shared",
      store: createRedisRateLimitStore({ client }),
    });

    expect((await appA.inject({ url: "/api" })).status).toBe(200);
    expect((await appB.inject({ url: "/api" })).status).toBe(200);
    expect((await appA.inject({ url: "/api" })).status).toBe(200);
    // The 4th request across BOTH instances is blocked — the per-process
    // memory store would have allowed `max` per instance.
    expect((await appB.inject({ url: "/api" })).status).toBe(429);
  });

  it("fails closed on an unreadable reply rather than passing traffic", async () => {
    const store = createRedisRateLimitStore({ client: { eval: async () => null } });
    await expect(store.increment("k", 1000)).rejects.toThrow(CelsianError);
  });

  it("rejects a client without eval at construction", () => {
    expect(() => createRedisRateLimitStore({ client: {} as RedisRateLimitClient })).toThrow(CelsianError);
  });
});

describe("IP / CIDR parsing", () => {
  it("parses IPv4, IPv6, ports, brackets and IPv4-mapped addresses", () => {
    expect(parseIp("192.168.1.1")).toEqual({ version: 4, value: 3232235777 });
    expect(parseIp("192.168.1.1:8080")).toEqual({ version: 4, value: 3232235777 });
    expect(parseIp("::ffff:192.168.1.1")).toEqual({ version: 4, value: 3232235777 });
    expect(parseIp("[2001:db8::1]:443")?.version).toBe(6);
    expect(parseIp("2001:db8::1")?.version).toBe(6);
    expect(parseIp("999.1.1.1")).toBeNull();
    expect(parseIp("nonsense")).toBeNull();
  });

  it("matches IPv4 prefixes", () => {
    const cidr = parseCidr("10.0.0.0/8")!;
    expect(ipInCidr(parseIp("10.4.5.6")!, cidr)).toBe(true);
    expect(ipInCidr(parseIp("11.0.0.1")!, cidr)).toBe(false);
    expect(ipInCidr(parseIp("2001:db8::1")!, cidr)).toBe(false);
  });

  it("matches IPv6 prefixes and exact addresses", () => {
    const cidr = parseCidr("2001:db8::/32")!;
    expect(ipInCidr(parseIp("2001:db8:1234::9")!, cidr)).toBe(true);
    expect(ipInCidr(parseIp("2001:db9::1")!, cidr)).toBe(false);

    const exact = parseCidr("203.0.113.5")!;
    expect(exact.prefix).toBe(32);
    expect(ipInCidr(parseIp("203.0.113.5")!, exact)).toBe(true);
    expect(ipInCidr(parseIp("203.0.113.6")!, exact)).toBe(false);
  });

  it("treats /0 as matching everything of the same family", () => {
    expect(ipInCidr(parseIp("8.8.8.8")!, parseCidr("0.0.0.0/0")!)).toBe(true);
  });
});
