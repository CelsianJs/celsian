// @celsian/rate-limit, the bucket key must never be attacker-choosable

import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hash.js";
import { canonicalizeIp, type RateLimitOptions, type RateLimitStore, rateLimit } from "../src/index.js";

async function buildApp(options: RateLimitOptions) {
  const app = createApp();
  await app.register(rateLimit(options), { encapsulate: false });
  app.get("/api", (_req, reply) => reply.json({ ok: true }));
  return app;
}

/** Statuses of `n` sequential requests, one header set per iteration. */
async function statuses(
  app: Awaited<ReturnType<typeof buildApp>>,
  n: number,
  headers: (i: number) => Record<string, string>,
): Promise<number[]> {
  const result: number[] = [];
  for (let i = 0; i < n; i++) {
    result.push((await app.inject({ url: "/api", headers: headers(i) })).status);
  }
  return result;
}

describe("hop-count mode fails closed on a short chain (M-1)", () => {
  it("SECURITY: a chain shorter than trustedProxyHops does not become the bucket key", async () => {
    // 3 declared hops, but the attacker reaches the app with a 1-entry header
    // (a leaked origin, a misrouted health check, an internal caller). Clamping
    // the index to 0 selected that single fully client-supplied entry.
    const app = await buildApp({ max: 2, window: 60_000, trustProxy: true, trustedProxyHops: 3 });

    const seen = await statuses(app, 6, (i) => ({ "x-forwarded-for": `9.9.9.${i}` }));

    // All six share the "unidentified" bucket, so the limit actually applies.
    // Before the fix every one of these returned 200: rotating a single header
    // value minted a fresh bucket per request, an unlimited-quota bypass.
    expect(seen.filter((s) => s === 200)).toHaveLength(2);
    expect(seen.filter((s) => s === 429)).toHaveLength(4);
  });

  it("SECURITY: an attacker cannot exhaust a DIFFERENT user's bucket (targeted lockout)", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustProxy: true, trustedProxyHops: 3 });

    // The attacker bypasses the proxy chain and claims to BE the victim.
    // Clamping selected this value, so it landed in the victim's bucket.
    const attack = await statuses(app, 4, () => ({ "x-forwarded-for": "203.0.113.9" }));
    expect(attack).toEqual([200, 200, 200, 429]);

    // The victim's genuine request, arriving through the full declared chain,
    // must find an untouched bucket. Before the fix this was a 429 on their
    // very first request: a remote lockout of any IP the attacker names.
    const victim = await app.inject({
      url: "/api",
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" },
    });
    expect(victim.status).toBe(200);
    expect(victim.headers.get("x-ratelimit-remaining")).toBe("2");
  });

  it("still keys a chain of exactly trustedProxyHops entries on its leftmost entry", async () => {
    // Not a regression: with N hops and exactly N entries, entry 0 IS what the
    // outermost proxy saw. Only a SHORTER chain is untrustworthy.
    const app = await buildApp({ max: 1, window: 60_000, trustProxy: true, trustedProxyHops: 2 });

    const seen = await statuses(app, 2, () => ({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }));
    expect(seen).toEqual([200, 429]);

    const other = await app.inject({ url: "/api", headers: { "x-forwarded-for": "203.0.113.6, 10.0.0.1" } });
    expect(other.status).toBe(200);
  });
});

describe("the bucket key is the canonical address, not raw header text (M-2)", () => {
  const SPELLINGS = ["1.2.3.4", "01.02.03.04", "::ffff:1.2.3.4", "[1.2.3.4]", "1.2.3.4:1", "1.2.3.4:2"];

  it("canonicalizeIp collapses every spelling of one host", () => {
    for (const spelling of SPELLINGS) {
      expect(canonicalizeIp(spelling)).toBe("1.2.3.4");
    }
    // IPv6 is expanded and lowercased, so compression and case cannot fork a bucket.
    expect(canonicalizeIp("2001:DB8::1")).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(canonicalizeIp("[2001:db8::1]:443")).toBe(canonicalizeIp("2001:db8::1"));
    // Different hosts stay different, and non-addresses fail closed.
    expect(canonicalizeIp("1.2.3.5")).not.toBe(canonicalizeIp("1.2.3.4"));
    expect(canonicalizeIp("not-an-ip")).toBeNull();
  });

  it("SECURITY: rewriting the same address six ways does not mint six buckets", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustedProxies: ["10.0.0.0/8"] });

    // Every one of these parses to the same host. Keyed on the raw text each
    // got its OWN bucket, so all six returned 200 with remaining=2.
    const seen = await statuses(app, SPELLINGS.length, (i) => ({
      "x-forwarded-for": `${SPELLINGS[i]}, 10.0.0.1`,
    }));
    expect(seen).toEqual([200, 200, 200, 429, 429, 429]);
  });

  it("SECURITY: the port suffix is not an unbounded bucket generator", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustedProxies: ["10.0.0.0/8"] });

    // `:<port>` has 65k+ values and none of them change the host. Raw-text
    // keying made this an unlimited quota with a one-character mutation.
    const seen = await statuses(app, 50, (i) => ({ "x-forwarded-for": `1.2.3.4:${i}, 10.0.0.1` }));
    expect(seen.filter((s) => s === 200)).toHaveLength(3);
    expect(seen.filter((s) => s === 429)).toHaveLength(47);
  });

  it("SECURITY: hop-count mode canonicalizes too", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustProxy: true, trustedProxyHops: 1 });
    const seen = await statuses(app, 50, (i) => ({ "x-forwarded-for": `10.0.0.1, 1.2.3.4:${i}` }));
    expect(seen.filter((s) => s === 200)).toHaveLength(3);
  });

  it("SECURITY: an unparseable entry falls back to the shared bucket, not to itself", async () => {
    const app = await buildApp({ max: 3, window: 60_000, trustedProxies: ["10.0.0.0/8"] });

    // Rotating text that is not an address at all. Keyed verbatim this was the
    // same unlimited bypass with no IP syntax required.
    const seen = await statuses(app, 20, (i) => ({ "x-forwarded-for": `garbage-${i}, 10.0.0.1` }));
    expect(seen.filter((s) => s === 429)).toHaveLength(17);
  });

  it("SECURITY: a trusted X-Real-IP is canonicalized as well", async () => {
    const app = await buildApp({
      max: 3,
      window: 60_000,
      trustedProxies: ["10.0.0.0/8"],
      trustXRealIp: true,
    });
    const seen = await statuses(app, SPELLINGS.length, (i) => ({ "x-real-ip": SPELLINGS[i]! }));
    expect(seen).toEqual([200, 200, 200, 429, 429, 429]);
  });
});

describe("over-long keys are hashed, not merged (L-1)", () => {
  /** Records every key handed to the store so we can assert what got stored. */
  function recordingStore(): RateLimitStore & { keys: string[] } {
    const counts = new Map<string, number>();
    const keys: string[] = [];
    return {
      keys,
      async increment(key, window) {
        keys.push(key);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { count, resetAt: Date.now() + window };
      },
    };
  }

  const longKey = (who: string) => who.repeat(300);

  it("SECURITY: one user's long key cannot throttle a different user", async () => {
    const app = await buildApp({
      max: 3,
      window: 60_000,
      keyGenerator: (req) => longKey(req.headers.get("x-api-key") ?? "?"),
    });

    // User A exhausts their own quota. Their key is >256 chars, which is
    // perfectly legitimate (a composite tenant+user key, a long token subject).
    const a = await statuses(app, 4, () => ({ "x-api-key": "A" }));
    expect(a).toEqual([200, 200, 200, 429]);

    // User B has never sent a request. Collapsing every over-long key into one
    // shared bucket made B inherit A's count and get a 429 immediately.
    const b = await app.inject({ url: "/api", headers: { "x-api-key": "B" } });
    expect(b.status).toBe(200);
    expect(b.headers.get("x-ratelimit-remaining")).toBe("2");
  });

  it("still bounds the stored key length instead of storing it verbatim", async () => {
    const store = recordingStore();
    const app = await buildApp({
      max: 100,
      window: 60_000,
      store,
      keyGenerator: (req) => (req.headers.get("x-api-key") ?? "?").padEnd(20_000, "9"),
    });

    await statuses(app, 5, (i) => ({ "x-api-key": `user-${i}` }));

    // Memory stays bounded (this is what the shared bucket was protecting), and
    // the keys stay distinct (this is what it was breaking).
    for (const key of store.keys) expect(key.length).toBeLessThanOrEqual(80);
    expect(new Set(store.keys).size).toBe(5);
  });

  it("is deterministic: the same long key maps to the same bucket every time", async () => {
    const store = recordingStore();
    const app = await buildApp({ max: 100, window: 60_000, store, keyGenerator: () => longKey("Z") });
    await statuses(app, 3, () => ({}));
    expect(new Set(store.keys).size).toBe(1);
  });

  it("leaves keys at or below maxKeyLength untouched", async () => {
    const store = recordingStore();
    const app = await buildApp({ max: 100, window: 60_000, store, keyGenerator: () => "plain-key" });
    await statuses(app, 1, () => ({}));
    expect(store.keys).toEqual(["plain-key"]);
  });

  it("uses a real SHA-256 (FIPS 180-4 known answers), so collisions are not searchable", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    // A 20 KB input still hashes to the same fixed 64 hex characters.
    expect(sha256Hex("x".repeat(20_000))).toHaveLength(64);
  });
});
