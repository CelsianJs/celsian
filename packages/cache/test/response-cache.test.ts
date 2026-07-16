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
    await cache.cached(makeRequest("/data", "GET", { "accept-language": "en" }), handler);
    await cache.cached(makeRequest("/data", "GET", { "accept-language": "fr" }), handler);

    expect(callCount).toBe(2);

    // Same language as first request — should be a HIT
    const res = await cache.cached(makeRequest("/data", "GET", { "accept-language": "en" }), handler);
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

    const res1 = await cache.cached(makeRequest("/page", "GET", { "accept-language": "en" }), handler);
    const res2 = await cache.cached(makeRequest("/page", "GET", { "accept-language": "de" }), handler);

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
    const res1 = await cache.cached(makeRequest("/data", "GET", { "accept-language": "en" }), handler);
    expect(res1.headers.get("x-cache")).toBe("MISS");
    expect(res1.headers.get("vary")).toBe("accept-language, accept-encoding");

    // HIT response should also include Vary header (from stored headers)
    const res2 = await cache.cached(makeRequest("/data", "GET", { "accept-language": "en" }), handler);
    expect(res2.headers.get("x-cache")).toBe("HIT");

    store.destroy();
  });

  it("merges configured Vary headers with the handler response Vary header", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store, varyHeaders: ["accept-language"] });

    const handler = () =>
      new Response("ok", {
        headers: { vary: "Origin" },
      });

    const response = await cache.cached(
      makeRequest("/merged-vary", "GET", {
        origin: "https://app.example",
        "accept-language": "en",
      }),
      handler,
    );
    const vary = new Set(
      (response.headers.get("vary") ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean),
    );

    expect(vary).toEqual(new Set(["origin", "accept-language"]));
    store.destroy();
  });

  it("caches a response Vary header only when every field is represented in the cache key", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store, varyHeaders: ["accept-language"] });

    let callCount = 0;
    const request = (language: string) => makeRequest("/localized", "GET", { "accept-language": language });
    const handler = (language: string) => () =>
      new Response(JSON.stringify({ language, callCount: ++callCount }), {
        headers: {
          "content-type": "application/json",
          vary: "Accept-Language",
        },
      });

    const en = await cache.cached(request("en"), handler("en"));
    const fr = await cache.cached(request("fr"), handler("fr"));
    const enHit = await cache.cached(request("en"), handler("en"));

    expect(en.headers.get("x-cache")).toBe("MISS");
    expect(fr.headers.get("x-cache")).toBe("MISS");
    expect(enHit.headers.get("x-cache")).toBe("HIT");
    expect(await enHit.json()).toEqual({ language: "en", callCount: 1 });
    expect(callCount).toBe(2);

    store.destroy();
  });

  it("does not cache when Vary contains an unrepresented X-Tenant field", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store, varyHeaders: ["accept-language"] });

    let callCount = 0;
    const request = (tenant: string) =>
      makeRequest("/tenant", "GET", {
        "accept-language": "en",
        "x-tenant": tenant,
      });
    const handler = (tenant: string) => () =>
      new Response(JSON.stringify({ tenant, callCount: ++callCount }), {
        headers: {
          "content-type": "application/json",
          vary: "Accept-Language, X-Tenant",
        },
      });

    const tenantA = await cache.cached(request("tenant-a"), handler("tenant-a"));
    const tenantB = await cache.cached(request("tenant-b"), handler("tenant-b"));

    expect(tenantA.headers.get("x-cache")).toBeNull();
    expect(tenantB.headers.get("x-cache")).toBeNull();
    expect(await tenantA.json()).toEqual({ tenant: "tenant-a", callCount: 1 });
    expect(await tenantB.json()).toEqual({ tenant: "tenant-b", callCount: 2 });
    expect(callCount).toBe(2);

    store.destroy();
  });

  it("separates response bodies and CORS headers when the response varies by Origin", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const request = (origin: string) => makeRequest("/cors-data", "GET", { origin });
    const handler = (origin: string) => () => {
      callCount++;
      return new Response(JSON.stringify({ origin, callCount }), {
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": origin,
          vary: "Origin",
        },
      });
    };

    const originA = await cache.cached(request("https://a.example"), handler("https://a.example"));
    const originB = await cache.cached(request("https://b.example"), handler("https://b.example"));
    const originAHit = await cache.cached(request("https://a.example"), handler("https://a.example"));

    expect(originA.headers.get("x-cache")).toBe("MISS");
    expect(originA.headers.get("access-control-allow-origin")).toBe("https://a.example");
    expect(await originA.json()).toEqual({ origin: "https://a.example", callCount: 1 });

    expect(originB.headers.get("x-cache")).toBe("MISS");
    expect(originB.headers.get("access-control-allow-origin")).toBe("https://b.example");
    expect(await originB.json()).toEqual({ origin: "https://b.example", callCount: 2 });

    expect(originAHit.headers.get("x-cache")).toBe("HIT");
    expect(originAHit.headers.get("access-control-allow-origin")).toBe("https://a.example");
    expect(await originAHit.json()).toEqual({ origin: "https://a.example", callCount: 1 });
    expect(callCount).toBe(2);

    store.destroy();
  });

  it("never stores a response marked Cache-Control: no-cache", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () =>
      new Response(JSON.stringify({ value: ++callCount }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, no-cache",
        },
      });

    const first = await cache.cached(makeRequest("/must-revalidate"), handler);
    const second = await cache.cached(makeRequest("/must-revalidate"), handler);

    expect(first.headers.get("x-cache")).toBeNull();
    expect(second.headers.get("x-cache")).toBeNull();
    expect(await first.json()).toEqual({ value: 1 });
    expect(await second.json()).toEqual({ value: 2 });
    expect(callCount).toBe(2);

    store.destroy();
  });

  it("bypasses an existing cache entry when the request requires no-cache", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () => jsonResponse({ value: ++callCount });

    const initial = await cache.cached(makeRequest("/refresh"), handler);
    const refreshed = await cache.cached(makeRequest("/refresh", "GET", { "cache-control": "no-cache" }), handler);

    expect(initial.headers.get("x-cache")).toBe("MISS");
    expect(refreshed.headers.get("x-cache")).not.toBe("HIT");
    expect(await refreshed.json()).toEqual({ value: 2 });
    expect(callCount).toBe(2);

    store.destroy();
  });

  it.each([
    "max-age=0",
    "public, s-maxage=0",
  ])("never stores a response whose Cache-Control is %s", async (cacheControl) => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store, ttlMs: 60_000 });

    let callCount = 0;
    const handler = () =>
      new Response(JSON.stringify({ value: ++callCount }), {
        headers: {
          "content-type": "application/json",
          "cache-control": cacheControl,
        },
      });

    const first = await cache.cached(makeRequest("/zero-age"), handler);
    const second = await cache.cached(makeRequest("/zero-age"), handler);

    expect(first.headers.get("x-cache")).toBeNull();
    expect(second.headers.get("x-cache")).toBeNull();
    expect(await first.json()).toEqual({ value: 1 });
    expect(await second.json()).toEqual({ value: 2 });
    expect(callCount).toBe(2);

    store.destroy();
  });

  it("bypasses an existing cache entry for request Cache-Control: max-age=0", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () => jsonResponse({ value: ++callCount });

    await cache.cached(makeRequest("/request-zero-age"), handler);
    const refreshed = await cache.cached(
      makeRequest("/request-zero-age", "GET", { "cache-control": "max-age=0" }),
      handler,
    );

    expect(refreshed.headers.get("x-cache")).not.toBe("HIT");
    expect(await refreshed.json()).toEqual({ value: 2 });
    expect(callCount).toBe(2);

    store.destroy();
  });

  it("does not share authenticated response bodies, headers, or cache status across users", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = (user: string) => () => {
      callCount++;
      return new Response(JSON.stringify({ user }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-tenant": user,
          etag: '"abc"',
        },
      });
    };

    const tenantA = await cache.cached(
      makeRequest("/account", "GET", { authorization: "Bearer tenant-a" }),
      handler("tenant-a"),
    );
    const tenantB = await cache.cached(
      makeRequest("/account", "GET", { authorization: "Bearer tenant-b" }),
      handler("tenant-b"),
    );

    expect(await tenantA.json()).toEqual({ user: "tenant-a" });
    expect(await tenantB.json()).toEqual({ user: "tenant-b" });
    expect(tenantA.headers.get("x-tenant")).toBe("tenant-a");
    expect(tenantB.headers.get("x-tenant")).toBe("tenant-b");
    expect(tenantA.headers.get("x-cache")).toBeNull();
    expect(tenantB.headers.get("x-cache")).toBeNull();
    expect(callCount).toBe(2);

    // Credentialed responses must not populate the cache for a later anonymous request.
    const anonymous = await cache.cached(makeRequest("/account"), handler("anonymous"));
    expect(await anonymous.json()).toEqual({ user: "anonymous" });
    expect(anonymous.headers.get("x-cache")).toBe("MISS");
    expect(callCount).toBe(3);

    store.destroy();
  });

  it.each([
    "authorization",
    "cookie",
    "proxy-authorization",
  ])("bypasses shared cache reads and writes for %s requests", async (header) => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () => jsonResponse({ value: ++callCount });

    const publicMiss = await cache.cached(makeRequest("/data"), handler);
    expect(publicMiss.headers.get("x-cache")).toBe("MISS");

    const privateResponse = await cache.cached(makeRequest("/data", "GET", { [header]: "private" }), handler);
    expect(privateResponse.headers.get("x-cache")).toBeNull();
    expect(await privateResponse.json()).toEqual({ value: 2 });

    const publicHit = await cache.cached(makeRequest("/data"), handler);
    expect(publicHit.headers.get("x-cache")).toBe("HIT");
    expect(await publicHit.json()).toEqual({ value: 1 });

    expect(callCount).toBe(2);
    store.destroy();
  });

  it("supports additional application-specific credential headers", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store, credentialHeaders: ["x-api-key"] });

    let callCount = 0;
    const handler = () => jsonResponse({ value: ++callCount });

    const first = await cache.cached(makeRequest("/data", "GET", { "x-api-key": "tenant-a" }), handler);
    const second = await cache.cached(makeRequest("/data", "GET", { "x-api-key": "tenant-b" }), handler);

    expect(first.headers.get("x-cache")).toBeNull();
    expect(second.headers.get("x-cache")).toBeNull();
    expect(await first.json()).toEqual({ value: 1 });
    expect(await second.json()).toEqual({ value: 2 });
    expect(callCount).toBe(2);
    store.destroy();
  });

  it.each([
    ["cache-control", "private"],
    ["cache-control", "max-age=60, no-store"],
    ["vary", "*"],
    ["set-cookie", "session=tenant-a; HttpOnly"],
  ])("does not store responses with %s: %s", async (header, value) => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });

    let callCount = 0;
    const handler = () =>
      new Response(JSON.stringify({ value: ++callCount }), {
        status: 200,
        headers: { "content-type": "application/json", [header]: value },
      });

    const first = await cache.cached(makeRequest("/private"), handler);
    const second = await cache.cached(makeRequest("/private"), handler);

    expect(first.headers.get("x-cache")).toBeNull();
    expect(second.headers.get("x-cache")).toBeNull();
    expect(await first.json()).toEqual({ value: 1 });
    expect(await second.json()).toEqual({ value: 2 });
    expect(callCount).toBe(2);

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
    await cache.cached(makeRequest("/data", "GET", { "accept-language": "en" }), handler);
    const res = await cache.cached(makeRequest("/data", "GET", { "accept-language": "fr" }), handler);

    expect(callCount).toBe(1);
    expect(res.headers.get("x-cache")).toBe("HIT");
    expect(res.headers.get("vary")).toBeNull();

    store.destroy();
  });
});
