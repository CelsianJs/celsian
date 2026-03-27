// @celsian/cache — KV Store tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKVStore } from "../src/store.js";

describe("MemoryKVStore", () => {
  let store: MemoryKVStore;

  beforeEach(() => {
    store = new MemoryKVStore({ cleanupIntervalMs: 0 });
  });

  afterEach(() => {
    store.destroy();
  });

  // ─── Basic CRUD ───

  it("get/set basic values", async () => {
    await store.set("name", "Alice");
    expect(await store.get("name")).toBe("Alice");
  });

  it("get returns undefined for missing keys", async () => {
    expect(await store.get("nonexistent")).toBeUndefined();
  });

  it("set overwrites existing values", async () => {
    await store.set("key", "v1");
    await store.set("key", "v2");
    expect(await store.get("key")).toBe("v2");
  });

  it("stores objects", async () => {
    const data = { id: 1, name: "test", nested: { x: true } };
    await store.set("obj", data);
    expect(await store.get("obj")).toEqual(data);
  });

  it("stores arrays", async () => {
    await store.set("arr", [1, 2, 3]);
    expect(await store.get("arr")).toEqual([1, 2, 3]);
  });

  it("delete removes a key", async () => {
    await store.set("key", "value");
    const result = await store.delete("key");
    expect(result).toBe(true);
    expect(await store.get("key")).toBeUndefined();
  });

  it("delete returns false for missing keys", async () => {
    expect(await store.delete("nonexistent")).toBe(false);
  });

  it("has checks existence", async () => {
    await store.set("key", "value");
    expect(await store.has("key")).toBe(true);
    expect(await store.has("missing")).toBe(false);
  });

  // ─── TTL ───

  it("respects TTL expiration", async () => {
    vi.useFakeTimers();
    try {
      await store.set("temp", "data", 100);
      expect(await store.get("temp")).toBe("data");

      vi.advanceTimersByTime(101);
      expect(await store.get("temp")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("has returns false for expired keys", async () => {
    vi.useFakeTimers();
    try {
      await store.set("temp", "data", 50);
      vi.advanceTimersByTime(51);
      expect(await store.has("temp")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ttl returns remaining time", async () => {
    vi.useFakeTimers();
    try {
      await store.set("key", "value", 1000);
      vi.advanceTimersByTime(300);
      const remaining = await store.ttl("key");
      expect(remaining).toBe(700);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ttl returns -1 for keys without TTL", async () => {
    await store.set("key", "value");
    expect(await store.ttl("key")).toBe(-1);
  });

  it("ttl returns -2 for missing keys", async () => {
    expect(await store.ttl("missing")).toBe(-2);
  });

  // ─── Keys and Clear ───

  it("keys returns all keys", async () => {
    await store.set("a", 1);
    await store.set("b", 2);
    await store.set("c", 3);

    const keys = await store.keys();
    expect(keys.sort()).toEqual(["a", "b", "c"]);
  });

  it("keys supports glob patterns", async () => {
    await store.set("user:1", { name: "Alice" });
    await store.set("user:2", { name: "Bob" });
    await store.set("post:1", { title: "Hello" });

    const userKeys = await store.keys("user:*");
    expect(userKeys.sort()).toEqual(["user:1", "user:2"]);
  });

  it("keys excludes expired entries", async () => {
    vi.useFakeTimers();
    try {
      await store.set("alive", "yes");
      await store.set("dead", "yes", 50);
      vi.advanceTimersByTime(51);

      const keys = await store.keys();
      expect(keys).toEqual(["alive"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear removes all keys", async () => {
    await store.set("a", 1);
    await store.set("b", 2);
    await store.clear();

    expect(await store.keys()).toEqual([]);
  });

  it("clear with prefix removes only matching keys", async () => {
    await store.set("cache:a", 1);
    await store.set("cache:b", 2);
    await store.set("session:1", "data");

    await store.clear("cache:");

    const keys = await store.keys();
    expect(keys).toEqual(["session:1"]);
  });

  // ─── Batch Operations ───

  it("getMany returns values for multiple keys", async () => {
    await store.set("a", 1);
    await store.set("b", 2);

    const values = await store.getMany(["a", "b", "c"]);
    expect(values).toEqual([1, 2, undefined]);
  });

  it("setMany sets multiple values", async () => {
    await store.setMany([
      { key: "x", value: 10 },
      { key: "y", value: 20, ttlMs: 5000 },
    ]);

    expect(await store.get("x")).toBe(10);
    expect(await store.get("y")).toBe(20);
  });

  // ─── Atomic Counters ───

  it("incr increments numeric values", async () => {
    const v1 = await store.incr("counter");
    expect(v1).toBe(1);

    const v2 = await store.incr("counter");
    expect(v2).toBe(2);

    const v3 = await store.incr("counter", 5);
    expect(v3).toBe(7);
  });

  it("decr decrements numeric values", async () => {
    await store.set("counter", 10);
    const v1 = await store.decr("counter");
    expect(v1).toBe(9);

    const v2 = await store.decr("counter", 3);
    expect(v2).toBe(6);
  });

  it("incr starts from 0 for missing keys", async () => {
    expect(await store.incr("new")).toBe(1);
  });
});
