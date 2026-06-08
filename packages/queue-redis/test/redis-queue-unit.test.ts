// @celsian/queue-redis — unit tests with a mocked ioredis (no live server)

import type { QueueMessage } from "@celsian/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedisQueue } from "../src/index.js";

// Capture instances created via `new Redis(...)` so we can assert that owned
// clients get an 'error' listener and emitting 'error' is handled (item 2).
const ownedInstances: Array<ReturnType<typeof createFakeRedis>> = [];
vi.mock("ioredis", () => {
  return {
    default: class {
      constructor() {
        const f = createFakeRedis();
        f.status = "wait";
        ownedInstances.push(f);
        // biome-ignore lint/correctness/noConstructorReturn: test double returns the fake
        return f as unknown as object;
      }
    },
  };
});

/**
 * Minimal in-memory fake of the subset of ioredis the RedisQueue uses,
 * including `eval` for the two Lua scripts (atomic pop, reaper). This lets us
 * exercise the real RedisQueue logic without a live Redis server.
 *
 * Lists are modeled as arrays where index 0 is the HEAD (LPUSH prepends,
 * RPOP/RPOPLPUSH take from the tail) to match Redis semantics.
 */
function createFakeRedis() {
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Map<string, string>>();
  const zsets = new Map<string, Array<{ score: number; member: string }>>();

  const getList = (k: string) => {
    let l = lists.get(k);
    if (!l) {
      l = [];
      lists.set(k, l);
    }
    return l;
  };
  const getHash = (k: string) => {
    let h = hashes.get(k);
    if (!h) {
      h = new Map();
      hashes.set(k, h);
    }
    return h;
  };

  const fake = {
    status: "ready" as string,
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),

    lpush: vi.fn(async (key: string, ...vals: string[]) => {
      const l = getList(key);
      // LPUSH prepends each value; multiple values are pushed left-to-right.
      for (const v of vals) l.unshift(v);
      return l.length;
    }),
    rpop: vi.fn(async (key: string) => {
      const l = getList(key);
      return l.pop() ?? null;
    }),
    llen: vi.fn(async (key: string) => getList(key).length),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const l = getList(key);
      const end = stop === -1 ? l.length : stop + 1;
      return l.slice(start, end);
    }),
    lrem: vi.fn(async (key: string, count: number, value: string) => {
      const l = getList(key);
      let removed = 0;
      const limit = count === 0 ? Number.POSITIVE_INFINITY : Math.abs(count);
      for (let i = 0; i < l.length && removed < limit; ) {
        if (l[i] === value) {
          l.splice(i, 1);
          removed++;
        } else {
          i++;
        }
      }
      return removed;
    }),

    hset: vi.fn(async (key: string, field: string, value: string) => {
      getHash(key).set(field, value);
      return 1;
    }),
    hget: vi.fn(async (key: string, field: string) => getHash(key).get(field) ?? null),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      const h = getHash(key);
      let n = 0;
      for (const f of fields) if (h.delete(f)) n++;
      return n;
    }),

    zadd: vi.fn(async (key: string, score: number, member: string) => {
      let z = zsets.get(key);
      if (!z) {
        z = [];
        zsets.set(key, z);
      }
      z.push({ score, member });
      return 1;
    }),
    zcard: vi.fn(async (key: string) => zsets.get(key)?.length ?? 0),
    zrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
      const z = zsets.get(key) ?? [];
      return z.filter((e) => e.score >= min && e.score <= max).map((e) => e.member);
    }),

    del: vi.fn(async (...keys: string[]) => {
      for (const k of keys) {
        lists.delete(k);
        hashes.delete(k);
        zsets.delete(k);
      }
      return keys.length;
    }),
    quit: vi.fn().mockResolvedValue("OK"),

    pipeline: vi.fn(() => {
      const ops: Array<() => Promise<unknown>> = [];
      const p = {
        lpush: (key: string, val: string) => {
          ops.push(() => fake.lpush(key, val));
          return p;
        },
        lrem: (key: string, count: number, val: string) => {
          ops.push(() => fake.lrem(key, count, val));
          return p;
        },
        hdel: (key: string, field: string) => {
          ops.push(() => fake.hdel(key, field));
          return p;
        },
        zremrangebyscore: (key: string, min: number, max: number) => {
          ops.push(async () => {
            const z = zsets.get(key) ?? [];
            zsets.set(
              key,
              z.filter((e) => !(e.score >= min && e.score <= max)),
            );
          });
          return p;
        },
        exec: async () => {
          for (const op of ops) await op();
          return [];
        },
      };
      return p;
    }),

    // Emulate the two Lua scripts by their KEYS/ARGV contract.
    eval: vi.fn(async (script: string, _numKeys: number, ...args: string[]) => {
      if (script.includes("RPOPLPUSH")) {
        // KEYS: pending, processing, stamps ; ARGV: now
        const [pending, processing, stamps, now] = args;
        const pl = getList(pending);
        const raw = pl.pop();
        if (raw === undefined) return null;
        getList(processing).unshift(raw);
        getHash(stamps).set(raw, now);
        return raw;
      }
      // Reaper: KEYS processing, stamps, pending ; ARGV cutoff
      const [processing, stamps, pending, cutoff] = args;
      const pl = getList(processing);
      const sh = getHash(stamps);
      const cut = Number(cutoff);
      let reclaimed = 0;
      for (const raw of [...pl]) {
        const stamp = sh.get(raw);
        if (stamp === undefined || Number(stamp) <= cut) {
          const idx = pl.indexOf(raw);
          if (idx !== -1) pl.splice(idx, 1);
          sh.delete(raw);
          getList(pending).unshift(raw);
          reclaimed++;
        }
      }
      return reclaimed;
    }),

    // Test inspection helpers
    _lists: lists,
    _hashes: hashes,
  };

  return fake;
}

function makeMessage(id: string, overrides: Partial<QueueMessage> = {}): QueueMessage {
  return {
    id,
    taskName: "t",
    input: {},
    attempt: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    availableAt: 0,
    ...overrides,
  };
}

describe("RedisQueue (mocked ioredis)", () => {
  let fake: ReturnType<typeof createFakeRedis>;
  let queue: RedisQueue;

  beforeEach(() => {
    fake = createFakeRedis();
    queue = new RedisQueue({
      client: fake as never,
      prefix: "celsian:test:q",
      visibilityTimeout: 1000,
    });
  });

  it("pop uses an atomic eval (not rpop-then-hset)", async () => {
    await queue.push(makeMessage("m1"));

    const msg = await queue.pop();

    expect(msg?.id).toBe("m1");
    // Atomic move: eval was used, the legacy non-atomic pair was NOT.
    expect(fake.eval).toHaveBeenCalled();
    expect(fake.rpop).not.toHaveBeenCalled();
    expect(fake.hset).not.toHaveBeenCalled();

    // The popped message is tracked in the processing list + stamps hash.
    expect(fake._lists.get("celsian:test:q:processing")?.length).toBe(1);
    expect(fake._hashes.get("celsian:test:q:stamps")?.size).toBe(1);
  });

  it("ack removes the message from the processing structures", async () => {
    await queue.push(makeMessage("ack-me"));
    const msg = await queue.pop();
    expect(msg).not.toBeNull();

    await queue.ack("ack-me");

    expect(fake._lists.get("celsian:test:q:processing")?.length).toBe(0);
    expect(fake._hashes.get("celsian:test:q:stamps")?.size).toBe(0);
  });

  it("reaper re-queues in-flight entries older than visibilityTimeout", async () => {
    await queue.push(makeMessage("stale"));

    // Pop it so it lands in processing with a stamp.
    const popped = await queue.pop();
    expect(popped?.id).toBe("stale");
    expect(fake._lists.get("celsian:test:q:processing")?.length).toBe(1);

    // Backdate the stamp so it is older than the 1000ms visibility timeout.
    const stamps = fake._hashes.get("celsian:test:q:stamps");
    const rawKey = [...(stamps?.keys() ?? [])][0];
    stamps?.set(rawKey, String(Date.now() - 5000));

    const reclaimed = await queue.reap();

    expect(reclaimed).toBe(1);
    // Moved back out of processing and into pending.
    expect(fake._lists.get("celsian:test:q:processing")?.length).toBe(0);
    expect(fake._lists.get("celsian:test:q:pending")?.length).toBe(1);
  });

  it("reaper leaves fresh in-flight entries alone", async () => {
    await queue.push(makeMessage("fresh"));
    await queue.pop(); // stamped with Date.now(), well within visibility timeout

    const reclaimed = await queue.reap();

    expect(reclaimed).toBe(0);
    expect(fake._lists.get("celsian:test:q:processing")?.length).toBe(1);
  });

  it("does NOT auto-attach an 'error' listener to an external (caller-owned) client", () => {
    const external = createFakeRedis();
    new RedisQueue({ client: external as never });
    expect(external.on).not.toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("attaches an 'error' listener to an owned client; emitting 'error' is handled and does not throw", () => {
    ownedInstances.length = 0;
    const onError = vi.fn();
    new RedisQueue({ url: "redis://localhost:6379", onError });

    expect(ownedInstances).toHaveLength(1);
    const owned = ownedInstances[0];
    // An 'error' listener was registered on the owned client.
    const errCall = owned.on.mock.calls.find((c) => c[0] === "error");
    expect(errCall).toBeDefined();

    // Invoking the registered handler (as ioredis would on a connection error)
    // must be handled gracefully — it routes to our onError, never throwing.
    const handler = errCall?.[1] as (e: Error) => void;
    expect(() => handler(new Error("ECONNREFUSED"))).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
