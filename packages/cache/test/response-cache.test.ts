// @celsian/cache — Response cache tests

import { describe, expect, it, vi } from "vitest";
import { createResponseCache } from "../src/response-cache.js";
import { MemoryKVStore } from "../src/store.js";

function makeRequest(url: string, method = "GET", headers?: Record<string, string>): Request {
  return new Request(`http://localhost${url}`, { method, headers });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Response Cache", () => {
  it("caches GET responses", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ value: callCount });
    };

    // First call — MISS
    const res1 = await cache.cached(makeRequest("/data"), handler);
    expect(res1.headers.get("x-cache")).toBe("MISS");
    expect(await res1.json()).toEqual({ value: 1 });
    expect(callCount).toBe(1);

    // Second call — HIT (handler not called)
    const res2 = await cache.cached(makeRequest("/data"), handler);
    expect(res2.headers.get("x-cache")).toBe("HIT");
    expect(await res2.json()).toEqual({ value: 1 });
    expect(callCount).toBe(1);

    store.destroy();
  });

  it("does not cache POST by default", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ n: callCount });
    };

    await cache.cached(makeRequest("/data", "POST"), handler);
    await cache.cached(makeRequest("/data", "POST"), handler);

    expect(callCount).toBe(2);
    store.destroy();
  });

  it("does not cache non-200 responses", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ error: "not found" }, 404);
    };

    await cache.cached(makeRequest("/missing"), handler);
    await cache.cached(makeRequest("/missing"), handler);

    expect(callCount).toBe(2);
    store.destroy();
  });

  it("respects TTL", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
      const cache = createResponseCache({ store, ttlMs: 100 });

      let callCount = 0;
      const handler = () => {
        callCount++;
        return jsonResponse({ n: callCount });
      };

      await cache.cached(makeRequest("/data"), handler);
      expect(callCount).toBe(1);

      // Still cached
      await cache.cached(makeRequest("/data"), handler);
      expect(callCount).toBe(1);

      // TTL expired
      vi.advanceTimersByTime(101);
      await cache.cached(makeRequest("/data"), handler);
      expect(callCount).toBe(2);

      store.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes specified paths", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store, exclude: ["/api/health"] });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ ok: true });
    };

    await cache.cached(makeRequest("/api/health"), handler);
    await cache.cached(makeRequest("/api/health"), handler);
    expect(callCount).toBe(2);

    store.destroy();
  });

  it("wrap() creates a cached handler", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = (_req: Request) => {
      callCount++;
      return jsonResponse({ n: callCount });
    };

    const wrapped = cache.wrap(handler);

    await wrapped(makeRequest("/data"));
    await wrapped(makeRequest("/data"));

    expect(callCount).toBe(1);
    store.destroy();
  });

  it("invalidate removes a cached entry", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ n: callCount });
    };

    await cache.cached(makeRequest("/data"), handler);
    expect(callCount).toBe(1);

    await cache.invalidate("GET:/data");

    await cache.cached(makeRequest("/data"), handler);
    expect(callCount).toBe(2);

    store.destroy();
  });

  it("invalidateAll clears all cached responses", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ n: callCount });
    };

    await cache.cached(makeRequest("/a"), handler);
    await cache.cached(makeRequest("/b"), handler);
    expect(callCount).toBe(2);

    await cache.invalidateAll();

    await cache.cached(makeRequest("/a"), handler);
    await cache.cached(makeRequest("/b"), handler);
    expect(callCount).toBe(4);

    store.destroy();
  });

  it("uses custom key generator", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({
      store,
      keyGenerator: (req) => new URL(req.url).pathname, // Ignore query string
    });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ n: callCount });
    };

    await cache.cached(makeRequest("/data?v=1"), handler);
    await cache.cached(makeRequest("/data?v=2"), handler);

    // Same cache entry because we ignore query string
    expect(callCount).toBe(1);

    store.destroy();
  });

  it("caches different query strings separately by default", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ n: callCount });
    };

    await cache.cached(makeRequest("/data?page=1"), handler);
    await cache.cached(makeRequest("/data?page=2"), handler);

    expect(callCount).toBe(2);

    store.destroy();
  });

  it("includes vary header values in cache key when configured", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({
      store,
      varyHeaders: ["accept-language"],
    });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ n: callCount });
    };

    // Same URL, different Accept-Language — should be cached separately
    await cache.cached(
      makeRequest("/data", "GET", { "accept-language": "en" }),
      handler,
    );
    await cache.cached(
      makeRequest("/data", "GET", { "accept-language": "fr" }),
      handler,
    );

    expect(callCount).toBe(2);

    // Same language as first request — should be a HIT
    const res = await cache.cached(
      makeRequest("/data", "GET", { "accept-language": "en" }),
      handler,
    );
    expect(res.headers.get("x-cache")).toBe("HIT");
    expect(callCount).toBe(2);

    store.destroy();
  });

  it("produces different cache keys for different Accept-Language values", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({
      store,
      varyHeaders: ["accept-language"],
    });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ lang: callCount === 1 ? "en" : "de" });
    };

    const res1 = await cache.cached(
      makeRequest("/page", "GET", { "accept-language": "en" }),
      handler,
    );
    const res2 = await cache.cached(
      makeRequest("/page", "GET", { "accept-language": "de" }),
      handler,
    );

    expect(await res1.json()).toEqual({ lang: "en" });
    expect(await res2.json()).toEqual({ lang: "de" });
    expect(callCount).toBe(2);

    store.destroy();
  });

  it("adds Vary header to cached responses when varyHeaders configured", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({
      store,
      varyHeaders: ["accept-language", "accept-encoding"],
    });

    const handler = () => jsonResponse({ ok: true });

    // MISS response should include Vary header
    const res1 = await cache.cached(
      makeRequest("/data", "GET", { "accept-language": "en" }),
      handler,
    );
    expect(res1.headers.get("x-cache")).toBe("MISS");
    expect(res1.headers.get("vary")).toBe("accept-language, accept-encoding");

    // HIT response should also include Vary header (from stored headers)
    const res2 = await cache.cached(
      makeRequest("/data", "GET", { "accept-language": "en" }),
      handler,
    );
    expect(res2.headers.get("x-cache")).toBe("HIT");

    store.destroy();
  });

  it("behaves the same as before when varyHeaders is not set", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () => {
      callCount++;
      return jsonResponse({ n: callCount });
    };

    // Different Accept-Language headers but no varyHeaders configured
    // — should share the same cache entry
    await cache.cached(
      makeRequest("/data", "GET", { "accept-language": "en" }),
      handler,
    );
    const res = await cache.cached(
      makeRequest("/data", "GET", { "accept-language": "fr" }),
      handler,
    );

    expect(callCount).toBe(1);
    expect(res.headers.get("x-cache")).toBe("HIT");
    expect(res.headers.get("vary")).toBeNull();

    store.destroy();
  });
});
