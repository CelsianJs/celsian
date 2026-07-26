// @celsian/cache — host keying, poisoning vectors, stampede protection, store & session integrity

import { describe, expect, it, vi } from "vitest";
import { createResponseCache } from "../src/response-cache.js";
import { createSessionManager } from "../src/session.js";
import { MemoryKVStore } from "../src/store.js";

function request(url: string, headers?: Record<string, string>): Request {
  return new Request(url, { headers });
}

function jsonResponse(data: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("cache key includes the Host (H-10)", () => {
  it("does not serve tenant-a's body to tenant-b", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    // One process, two domains, one store. Keying on the path alone made the
    // second tenant a cache HIT on the first tenant's body.
    const forHost = (host: string) => () => jsonResponse({ tenant: host });

    const a = await cache.cached(request("https://tenant-a.example/data"), forHost("tenant-a"));
    expect(await a.json()).toEqual({ tenant: "tenant-a" });

    const b = await cache.cached(request("https://tenant-b.example/data"), forHost("tenant-b"));
    expect(b.headers.get("x-cache")).toBe("MISS");
    expect(await b.json()).toEqual({ tenant: "tenant-b" });

    store.destroy();
  });

  it("still caches repeat requests for the same host", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });
    let calls = 0;
    const handler = () => {
      calls++;
      return jsonResponse({ calls });
    };

    await cache.cached(request("https://tenant-a.example/data"), handler);
    const second = await cache.cached(request("https://tenant-a.example/data"), handler);
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(calls).toBe(1);
    store.destroy();
  });

  it("treats different ports as different hosts", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });
    let calls = 0;
    const handler = () => jsonResponse({ n: ++calls });

    await cache.cached(request("http://localhost:3000/data"), handler);
    await cache.cached(request("http://localhost:4000/data"), handler);
    expect(calls).toBe(2);
    store.destroy();
  });

  it("invalidate() accepts the host-less key form", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });
    let calls = 0;
    const handler = () => jsonResponse({ n: ++calls });

    await cache.cached(request("https://tenant-a.example/data"), handler);
    expect(await cache.invalidate("GET:/data")).toBe(true);
    await cache.cached(request("https://tenant-a.example/data"), handler);
    expect(calls).toBe(2);
    store.destroy();
  });
});

describe("cache poisoning via unkeyed request headers (H-11)", () => {
  it("does not serve an X-Forwarded-Host-poisoned body to other visitors", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    // The canonical poisoning vector: the handler builds an absolute asset URL
    // from X-Forwarded-Host. One unauthenticated request previously served
    // `<script src="https://evil.attacker.com/app.js">` to every anonymous
    // visitor for the whole TTL.
    const handler = (req: Request) => {
      const host = req.headers.get("x-forwarded-host") ?? "app.example.com";
      return new Response(`<script src="https://${host}/app.js"></script>`, {
        headers: { "content-type": "text/html" },
      });
    };

    const poisoned = await cache.cached(
      request("https://app.example.com/", { "x-forwarded-host": "evil.attacker.com" }),
      () => handler(request("https://app.example.com/", { "x-forwarded-host": "evil.attacker.com" })),
    );
    expect(await poisoned.text()).toContain("evil.attacker.com");

    const victim = await cache.cached(request("https://app.example.com/"), () =>
      handler(request("https://app.example.com/")),
    );
    expect(victim.headers.get("x-cache")).toBe("MISS");
    expect(await victim.text()).toContain("app.example.com/app.js");

    store.destroy();
  });

  it.each([
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-server",
    "x-host",
    "x-original-url",
    "x-rewrite-url",
  ])("partitions eagerly on %s", async (header) => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });
    let calls = 0;
    const handler = () => jsonResponse({ n: ++calls });

    await cache.cached(request("https://app.example/x", { [header]: "attacker" }), handler);
    const clean = await cache.cached(request("https://app.example/x"), handler);
    expect(clean.headers.get("x-cache")).toBe("MISS");
    expect(calls).toBe(2);
    store.destroy();
  });

  it("an unkeyed header a handler reflects is still a hazard unless listed in varyHeaders", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store, varyHeaders: ["x-country"] });
    const handler = (req: Request) => jsonResponse({ country: req.headers.get("x-country") ?? "none" });

    const uk = request("https://app.example/geo", { "x-country": "UK" });
    const us = request("https://app.example/geo", { "x-country": "US" });

    expect(await (await cache.cached(uk, () => handler(uk))).json()).toEqual({ country: "UK" });
    // Listed in varyHeaders => partitioned => no cross-serving.
    expect(await (await cache.cached(us, () => handler(us))).json()).toEqual({ country: "US" });
    store.destroy();
  });
});

describe("stampede protection", () => {
  it("executes the origin once for N concurrent cold-key requests", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let calls = 0;
    const handler = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({ calls });
    };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => cache.cached(request("https://app.example/slow"), handler)),
    );

    expect(calls).toBe(1);
    for (const response of responses) {
      expect(await response.json()).toEqual({ calls: 1 });
    }
    store.destroy();
  });

  it("does not share a non-storable response between coalesced callers", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let calls = 0;
    const handler = async () => {
      const n = ++calls;
      await new Promise((resolve) => setTimeout(resolve, 20));
      // `private` must never be replayed to a second caller.
      return jsonResponse({ n }, { "cache-control": "private" });
    };

    const [first, second] = await Promise.all([
      cache.cached(request("https://app.example/me"), handler),
      cache.cached(request("https://app.example/me"), handler),
    ]);

    expect(calls).toBe(2);
    expect(await first.json()).not.toEqual(await second.json());
    store.destroy();
  });

  it("never makes a no-cache request wait on someone else's in-flight execution", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });
    let calls = 0;
    const handler = async () => {
      const n = ++calls;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({ n });
    };

    // Start a normal request and let it get in flight.
    const leader = cache.cached(request("https://app.example/x"), handler);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // A `no-cache` request explicitly wants the origin, not a coalesced result.
    const revalidating = cache.cached(request("https://app.example/x", { "cache-control": "no-cache" }), handler);

    await Promise.all([leader, revalidating]);
    expect(calls).toBe(2);
    store.destroy();
  });

  it("does not wedge the key when the origin throws", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    await expect(
      cache.cached(request("https://app.example/boom"), () => {
        throw new Error("origin down");
      }),
    ).rejects.toThrow("origin down");

    const recovered = await cache.cached(request("https://app.example/boom"), () => jsonResponse({ ok: true }));
    expect(await recovered.json()).toEqual({ ok: true });
    store.destroy();
  });
});

describe("cache key hygiene", () => {
  it("normalizes query parameter order into one entry", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });
    let calls = 0;
    const handler = () => jsonResponse({ n: ++calls });

    await cache.cached(request("https://app.example/s?a=1&b=2"), handler);
    const reordered = await cache.cached(request("https://app.example/s?b=2&a=1"), handler);
    expect(reordered.headers.get("x-cache")).toBe("HIT");
    expect(calls).toBe(1);
    store.destroy();
  });

  it("drops unknown query parameters when an allow-list is configured", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0, maxEntries: 20 });
    const cache = createResponseCache({ store, queryParams: ["page"] });
    let calls = 0;
    const handler = () => jsonResponse({ n: ++calls });

    // The proven DoS: an unauthenticated `?cachebust=N` flood mints unlimited
    // keys and LRU-evicts the entry you wanted cached.
    await cache.cached(request("https://app.example/list?page=1"), handler);
    for (let i = 0; i < 100; i++) {
      await cache.cached(request(`https://app.example/list?page=1&cachebust=${i}`), handler);
    }

    expect(calls).toBe(1);
    expect((await store.keys()).length).toBe(1);
    store.destroy();
  });

  it("keeps allow-listed parameters distinct", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store, queryParams: ["page"] });
    let calls = 0;
    const handler = () => jsonResponse({ n: ++calls });

    await cache.cached(request("https://app.example/list?page=1"), handler);
    await cache.cached(request("https://app.example/list?page=2"), handler);
    expect(calls).toBe(2);
    store.destroy();
  });

  it("bypasses the cache entirely for an over-long key", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store, maxKeyLength: 64 });
    let calls = 0;
    const handler = () => jsonResponse({ n: ++calls });

    const long = `https://app.example/x?q=${"a".repeat(500)}`;
    await cache.cached(request(long), handler);
    await cache.cached(request(long), handler);

    expect(calls).toBe(2);
    expect(await store.keys()).toEqual([]);
    store.destroy();
  });
});

describe("MemoryKVStore.incr is atomic", () => {
  it("loses no updates under concurrency", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    await Promise.all(Array.from({ length: 500 }, () => store.incr("counter")));
    expect(await store.get<number>("counter")).toBe(500);
    store.destroy();
  });

  it("preserves the existing TTL", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
      await store.set("c", 1, 1_000);
      await store.incr("c");
      expect(await store.get<number>("c")).toBe(2);

      vi.advanceTimersByTime(1_001);
      expect(await store.get<number>("c")).toBeUndefined();
      store.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts from zero for a missing or non-numeric key", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    expect(await store.incr("fresh", 5)).toBe(5);
    await store.set("text", "not a number");
    expect(await store.incr("text")).toBe(1);
    expect(await store.decr("fresh", 2)).toBe(3);
    store.destroy();
  });
});

describe("session store integrity", () => {
  it("does not persist a session for a cookie-less request", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const sessions = createSessionManager({ store });

    // A crawler hitting 10k cookie-less routes previously wrote a 24h entry per
    // request, LRU-evicting every real logged-in session.
    for (let i = 0; i < 50; i++) {
      await sessions.fromRequest(new Request("https://app.example/"));
    }
    expect(await store.keys()).toEqual([]);
    store.destroy();
  });

  it("persists once the session actually holds data", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const sessions = createSessionManager({ store });

    const session = await sessions.create();
    expect(await store.keys()).toEqual([]);

    session.set("user", { id: 1 });
    await session.save();
    expect((await store.keys()).length).toBe(1);

    const loaded = await sessions.load(session.id);
    expect(loaded?.get("user")).toEqual({ id: 1 });
    store.destroy();
  });

  it("an anonymous flood cannot evict a logged-in session", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0, maxEntries: 10 });
    const sessions = createSessionManager({ store });

    const real = await sessions.create();
    real.set("user", { id: 42 });
    await real.save();

    for (let i = 0; i < 200; i++) {
      await sessions.fromRequest(new Request("https://app.example/"));
    }

    expect((await sessions.load(real.id))?.get("user")).toEqual({ id: 42 });
    store.destroy();
  });

  it("save() on an emptied session removes the entry", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const sessions = createSessionManager({ store });

    const session = await sessions.create({ user: "alice" });
    expect((await store.keys()).length).toBe(1);

    session.delete("user");
    await session.save();
    expect(await store.keys()).toEqual([]);
    store.destroy();
  });

  it("round-trips a custom generateId that needs percent-encoding", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    // A custom id containing characters outside the RFC 6265 cookie-octet set
    // is percent-encoded on write. Without decoding on read, every request
    // minted a fresh empty session and the user was never logged in.
    const customId = "user session;id=1";
    const sessions = createSessionManager({ store, generateId: () => customId });

    const session = await sessions.create();
    session.set("user", "alice");
    await session.save();

    const cookieHeader = sessions.cookie(session.id);
    expect(cookieHeader).toContain(encodeURIComponent(customId));

    const restored = await sessions.fromRequest(
      new Request("https://app.example/", { headers: { cookie: cookieHeader.split(";")[0]! } }),
    );
    expect(restored.id).toBe(customId);
    expect(restored.get("user")).toBe("alice");
    store.destroy();
  });

  it("tolerates a malformed percent sequence in the cookie", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const sessions = createSessionManager({ store });
    const restored = await sessions.fromRequest(
      new Request("https://app.example/", { headers: { cookie: "sid=100%" } }),
    );
    expect(restored.id).toBeTruthy();
    store.destroy();
  });

  it("keeps sessions safe from cache churn when the stores are separate", async () => {
    // Sharing ONE MemoryKVStore between sessions and the response cache lets
    // cache churn LRU-evict live sessions. Separate, bounded stores do not.
    const sessionStore = new MemoryKVStore({ cleanupIntervalMs: 0, maxEntries: 100 });
    const cacheStore = new MemoryKVStore({ cleanupIntervalMs: 0, maxEntries: 10 });
    const sessions = createSessionManager({ store: sessionStore });
    const cache = createResponseCache({ store: cacheStore });

    const session = await sessions.create({ user: "alice" });

    for (let i = 0; i < 200; i++) {
      await cache.cached(request(`https://app.example/page/${i}`), () => jsonResponse({ i }));
    }

    expect((await sessions.load(session.id))?.get("user")).toBe("alice");
    sessionStore.destroy();
    cacheStore.destroy();
  });
});
