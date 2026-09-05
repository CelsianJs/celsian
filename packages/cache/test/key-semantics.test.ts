// @celsian/cache, query ordering and bounded-key invalidation regressions

import { describe, expect, it } from "vitest";
import { createResponseCache } from "../src/response-cache.js";
import { MemoryKVStore } from "../src/store.js";

describe("response cache key semantics", () => {
  it.each([{ queryParams: undefined }, { queryParams: ["tag", "page"] }])(
    "preserves repeated query order with $queryParams",
    async ({ queryParams }) => {
      const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
      const cache = createResponseCache({ store, queryParams });
      let calls = 0;
      const handler = cache.wrap((request) => {
        calls++;
        return Response.json(new URL(request.url).searchParams.getAll("tag"));
      });

      const first = await handler(new Request("https://app.example/list?tag=first&page=1&tag=second"));
      const reversed = await handler(new Request("https://app.example/list?tag=second&page=1&tag=first"));
      const equivalent = await handler(new Request("https://app.example/list?page=1&tag=first&tag=second"));

      expect(await first.json()).toEqual(["first", "second"]);
      expect(await reversed.json()).toEqual(["second", "first"]);
      expect(reversed.headers.get("x-cache")).toBe("MISS");
      expect(await equivalent.json()).toEqual(["first", "second"]);
      expect(equivalent.headers.get("x-cache")).toBe("HIT");
      expect(calls).toBe(2);
      store.destroy();
    },
  );

  it.each([64, 512])("invalidates long paths across instances with a %i-character key budget", async (maxKeyLength) => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store, maxKeyLength });
    const path = `/${"a".repeat(550)}`;
    const url = `http://localhost:3000${path}`;
    const sibling = `${url}b`;
    const handler = () => new Response("original");

    await cache.cached(new Request(url), handler);
    await cache.cached(new Request(`${url}?page=2`, { headers: { origin: "https://other.example" } }), handler);
    await cache.cached(new Request(sibling), handler);
    expect((await store.keys()).every((key) => key.length <= maxKeyLength)).toBe(true);

    // Another process sharing the store must not need a local key index.
    const restarted = createResponseCache({ store, maxKeyLength });
    expect(await restarted.invalidate(`GET:${path}`)).toBe(true);
    const fresh = await restarted.cached(new Request(url), () => new Response("fresh"));
    expect(fresh.headers.get("x-cache")).toBe("MISS");
    expect(await fresh.text()).toBe("fresh");
    expect(
      (
        await restarted.cached(new Request(`${url}?page=2`, { headers: { origin: "https://other.example" } }), handler)
      ).headers.get("x-cache"),
    ).toBe("MISS");
    expect((await restarted.cached(new Request(sibling), handler)).headers.get("x-cache")).toBe("HIT");
    store.destroy();
  });

  it("invalidates a long query variant without purging other variants or hosts", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const cache = createResponseCache({ store });
    const query = `q=${"x".repeat(550)}`;
    const urls = [
      `https://app.example/list?${query}&tag=first&tag=second`,
      `https://app.example/list?${query}&tag=second&tag=first`,
      `https://other.example/list?${query}&tag=first&tag=second`,
    ];
    const handler = () => new Response("original");
    for (const url of urls) await cache.cached(new Request(url), handler);

    expect(await cache.invalidate(`GET:https//app.example:/list?${query}&tag=first&tag=second`)).toBe(true);
    for (const [index, url] of urls.entries()) {
      expect((await cache.cached(new Request(url), handler)).headers.get("x-cache")).toBe(index === 0 ? "MISS" : "HIT");
    }
    store.destroy();
  });

  it("invalidates an over-budget custom key", async () => {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const key = `custom:${"a".repeat(550)}`;
    const cache = createResponseCache({ store, keyGenerator: () => key });
    const request = new Request("https://app.example/list");
    const handler = () => new Response("original");
    await cache.cached(request, handler);

    expect(await cache.invalidate(key)).toBe(true);
    expect((await cache.cached(request, handler)).headers.get("x-cache")).toBe("MISS");
    store.destroy();
  });
});
