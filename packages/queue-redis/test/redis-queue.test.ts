// @celsian/queue-redis, integration tests against a REAL Redis server.
//
// These are the only tests that execute the Lua in src/index.ts. They must not
// be allowed to skip silently: in CI a missing Redis is a hard failure, because
// a permanently-skipped suite is how the non-atomic promoteDelayed bug survived.
// Locally they fall back to redis://127.0.0.1:6379 and skip with a loud notice.

import Redis from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueueMessage } from "../src/index.js";
import { RedisQueue } from "../src/index.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const IN_CI = Boolean(process.env.CI);

async function probeRedis(url: string): Promise<boolean> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on("error", () => {
    /* handled by the try/catch below */
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

const reachable = await probeRedis(REDIS_URL);

if (!reachable && !IN_CI) {
  console.warn(
    `[celsian:queue-redis] SKIPPING Redis integration tests: no server at ${REDIS_URL}. ` +
      "The Lua scripts are NOT covered by this run. Start one with: docker run --rm -p 6379:6379 redis:7-alpine",
  );
}

if (!reachable && IN_CI) {
  describe("RedisQueue integration", () => {
    it("requires a reachable Redis in CI", () => {
      throw new Error(
        `No Redis at ${REDIS_URL}. The queue-redis Lua scripts are executed by nothing without it, ` +
          "so CI must provide a Redis service container rather than skipping these tests.",
      );
    });
  });
}

const describeRedis = reachable ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let prefixCounter = 0;

describeRedis("RedisQueue (real Redis)", () => {
  let prefix: string;
  let queues: RedisQueue[];

  const makeQueue = (options: { visibilityTimeout?: number } = {}): RedisQueue => {
    const q = new RedisQueue({ url: REDIS_URL, prefix, ...options });
    queues.push(q);
    return q;
  };

  const message = (id: string, overrides: Partial<QueueMessage> = {}): QueueMessage => ({
    id,
    taskName: "test-task",
    input: {},
    attempt: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    availableAt: Date.now(),
    deliveries: 0,
    failures: [],
    ...overrides,
  });

  beforeEach(async () => {
    prefixCounter++;
    prefix = `celsian:test:${process.pid}:${prefixCounter}`;
    queues = [];
  });

  afterEach(async () => {
    if (queues.length > 0) {
      await queues[0]?.flush();
      await Promise.all(queues.map((q) => q.close()));
    }
  });

  describe("basics", () => {
    it("pushes and pops a message", async () => {
      const queue = makeQueue();
      await queue.push(message("msg-1", { input: { foo: "bar" } }));

      const msg = await queue.pop();
      expect(msg?.id).toBe("msg-1");
      expect(msg?.taskName).toBe("test-task");
      expect(msg?.input).toEqual({ foo: "bar" });
      expect(msg?.leaseToken).toBeTruthy();
    });

    it("returns null when the queue is empty", async () => {
      expect(await makeQueue().pop()).toBeNull();
    });

    it("acks a message so it is not redelivered", async () => {
      const queue = makeQueue();
      await queue.push(message("msg-2", { maxRetries: 0 }));

      const msg = await queue.pop();
      await queue.ack(msg?.id as string, msg?.leaseToken);

      expect(await queue.pop()).toBeNull();
      expect(await queue.inFlightSize()).toBe(0);
    });

    it("nacks and re-queues a message with an incremented attempt", async () => {
      const queue = makeQueue();
      await queue.push(message("msg-3"));

      const msg = await queue.pop();
      expect(msg?.attempt).toBe(0);
      await queue.nack(msg?.id as string, 0, msg?.leaseToken);

      const retried = await queue.pop();
      expect(retried?.id).toBe("msg-3");
      expect(retried?.attempt).toBe(1);
    });

    it("records failure history across nacks", async () => {
      const queue = makeQueue();
      await queue.push(message("msg-hist"));

      const first = await queue.pop();
      await queue.nack(first?.id as string, 0, first?.leaseToken, {
        attempt: 0,
        error: "first boom",
        failedAt: Date.now(),
      });

      const second = await queue.pop();
      expect(second?.failures).toHaveLength(1);
      expect(second?.failures?.[0]?.error).toBe("first boom");
    });

    it("reports size including delayed messages", async () => {
      const queue = makeQueue();
      expect(await queue.size()).toBe(0);
      await queue.push(message("s1"));
      await queue.push(message("s2", { availableAt: Date.now() + 60_000 }));
      expect(await queue.size()).toBe(2);
    });

    it("holds delayed messages until they are due", async () => {
      const queue = makeQueue();
      await queue.push(message("msg-delayed", { availableAt: Date.now() + 120 }));

      expect(await queue.pop()).toBeNull();
      await sleep(180);
      expect((await queue.pop())?.id).toBe("msg-delayed");
    });

    it("round-trips payloads that Redis' cjson would corrupt", async () => {
      // The reclaim path deliberately rewrites messages in JavaScript rather
      // than Lua, because cjson cannot tell an empty array from an empty object.
      const queue = makeQueue();
      const input = { emptyArray: [], emptyObject: {}, nested: [1, null, { a: [] }], big: "x".repeat(500) };
      await queue.push(message("fidelity", { input }));

      const popped = await queue.pop();
      await queue.nack(popped?.id as string, 0, popped?.leaseToken);
      const requeued = await queue.pop();

      expect(requeued?.input).toEqual(input);
      expect(Array.isArray((requeued!.input as { emptyArray: unknown }).emptyArray)).toBe(true);
    });
  });

  describe("concurrent delayed-message promotion", () => {
    it("promotes each due message exactly once when many workers promote at the same time", async () => {
      // Regression: promoteDelayed used ioredis pipeline(), which BATCHES but
      // does not make anything atomic. Every worker that read the same
      // zrangebyscore window LPUSHed the same messages, so each concurrent
      // promoter duplicated every delayed retry.
      const producer = makeQueue();
      const total = 50;
      for (let i = 0; i < total; i++) {
        await producer.push(message(`delayed-${i}`, { availableAt: Date.now() + 60 }));
      }
      await sleep(120);

      const workers = Array.from({ length: 8 }, () => makeQueue());
      const seen: string[] = [];
      for (let round = 0; round < total + 5; round++) {
        const popped = await Promise.all(workers.map((w) => w.pop()));
        const ids = popped.filter((m): m is QueueMessage => m !== null).map((m) => m.id);
        seen.push(...ids);
        if (ids.length === 0) break;
      }

      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
      expect(await producer.size()).toBe(0);
    });

    it("neither loses nor duplicates messages pushed while promotion is running", async () => {
      // Regression: zremrangebyscore(0, now) deleted by SCORE RANGE rather than
      // by the members actually read, so a due message pushed while the
      // (non-atomic) pipeline was in flight was silently deleted and never
      // promoted. Sustaining the race for hundreds of interleaved operations is
      // what makes that window reachable.
      const producer = makeQueue();
      const workers = Array.from({ length: 6 }, () => makeQueue());
      const preloaded = 200;
      const late = 100;
      const total = preloaded + late;
      const seen: string[] = [];

      // A large batch already due in the delayed set, so every concurrent
      // promoter reads an overlapping ready set. A future availableAt is what
      // routes a message through the delayed set at all.
      for (let i = 0; i < preloaded; i++) {
        await producer.push(message(`race-pre-${i}`, { availableAt: Date.now() + 40 }));
      }
      await sleep(60);

      // These land in the delayed set and fall due while promotion is running,
      // i.e. inside the score window the old implementation deleted blindly.
      const pushing = (async () => {
        for (let i = 0; i < late; i++) {
          await producer.push(message(`race-late-${i}`, { availableAt: Date.now() + 2 }));
        }
      })();
      const popping = Promise.all(
        workers.map(async (w) => {
          for (let i = 0; i < total; i++) {
            const msg = await w.pop();
            if (msg) seen.push(msg.id);
          }
        }),
      );
      await Promise.all([pushing, popping]);

      // Drain whatever the racing workers did not take.
      for (let i = 0; i < total + 10; i++) {
        const msg = await producer.pop();
        if (!msg) break;
        seen.push(msg.id);
      }

      // Nothing vanished...
      expect(new Set(seen).size).toBe(total);
      // ...and nothing was promoted twice.
      expect(seen).toHaveLength(total);
      expect(await producer.size()).toBe(0);
    });

    it("hands a given message to exactly one of many concurrent workers", async () => {
      const producer = makeQueue();
      const total = 100;
      for (let i = 0; i < total; i++) {
        await producer.push(message(`c-${i}`));
      }

      const workers = Array.from({ length: 6 }, () => makeQueue());
      const seen: string[] = [];
      for (let round = 0; round < total; round++) {
        const popped = await Promise.all(workers.map((w) => w.pop()));
        const ids = popped.filter((m): m is QueueMessage => m !== null).map((m) => m.id);
        seen.push(...ids);
        if (ids.length === 0) break;
      }

      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
    });
  });

  describe("lease tokens and heartbeats", () => {
    it("redelivers an abandoned message under a new lease token", async () => {
      const queue = makeQueue({ visibilityTimeout: 100 });
      await queue.push(message("lease-1"));

      const first = await queue.pop();
      await sleep(160);
      const second = await queue.pop();

      expect(second?.id).toBe("lease-1");
      expect(second?.leaseToken).not.toBe(first?.leaseToken);
      expect(second?.attempt).toBe(1);
      expect(second?.failures?.[0]?.error).toContain("Lease expired");
    });

    it("a stale lease cannot ack away the delivery another worker now owns", async () => {
      // Regression: reclaim reused the same job id and the processing entry was
      // the identical payload, so worker A's ack deleted worker B's in-flight
      // entry and B's completion silently vanished.
      const queue = makeQueue({ visibilityTimeout: 100 });
      await queue.push(message("overlap-1"));

      const workerA = await queue.pop();
      await sleep(160);
      const workerB = await queue.pop();
      expect(workerB?.id).toBe(workerA?.id);
      expect(await queue.inFlightSize()).toBe(1);

      await queue.ack("overlap-1", workerA?.leaseToken);
      expect(await queue.inFlightSize()).toBe(1);

      await queue.ack("overlap-1", workerB?.leaseToken);
      expect(await queue.inFlightSize()).toBe(0);
    });

    it("a stale lease cannot nack the delivery another worker now owns", async () => {
      const queue = makeQueue({ visibilityTimeout: 100 });
      await queue.push(message("overlap-2"));

      const workerA = await queue.pop();
      await sleep(160);
      const workerB = await queue.pop();

      await queue.nack("overlap-2", 0, workerA?.leaseToken);
      expect(await queue.inFlightSize()).toBe(1);
      expect(await queue.size()).toBe(0);

      await queue.nack("overlap-2", 0, workerB?.leaseToken);
      expect(await queue.size()).toBe(1);
    });

    it("extend() holds a lease past the visibility timeout and rejects a stale token", async () => {
      const queue = makeQueue({ visibilityTimeout: 150 });
      const reaper = makeQueue({ visibilityTimeout: 150 });
      await queue.push(message("heartbeat-1"));

      const msg = await queue.pop();
      const token = msg?.leaseToken as string;

      for (let i = 0; i < 3; i++) {
        await sleep(100);
        expect(await queue.extend("heartbeat-1", token)).toBe(true);
        expect(await reaper.reap()).toBe(0);
      }
      expect(await reaper.pop()).toBeNull();
      expect(await queue.inFlightSize()).toBe(1);

      expect(await queue.extend("heartbeat-1", "not-a-real-token")).toBe(false);
    });

    it("two concurrent reapers reclaim an expired lease exactly once", async () => {
      const owner = makeQueue({ visibilityTimeout: 80 });
      const reaperA = makeQueue({ visibilityTimeout: 80 });
      const reaperB = makeQueue({ visibilityTimeout: 80 });

      await owner.push(message("reclaim-1"));
      await owner.pop();
      await sleep(140);

      const [a, b] = await Promise.all([reaperA.reap(), reaperB.reap()]);
      expect(a + b).toBe(1);
      expect(await owner.size()).toBe(1);

      expect((await owner.pop())?.id).toBe("reclaim-1");
      expect(await owner.pop()).toBeNull();
    });
  });

  describe("dead-letter queue", () => {
    it("dead-letters a message that exhausts its retry budget on lease expiry", async () => {
      const queue = makeQueue({ visibilityTimeout: 60 });
      await queue.push(message("poison-1", { maxRetries: 1 }));

      await queue.pop();
      await sleep(100);
      await queue.pop();
      await sleep(100);
      expect(await queue.pop()).toBeNull();

      expect(await queue.deadLetterSize()).toBe(1);
      const [entry] = await queue.listDeadLetters();
      expect(entry?.message.id).toBe("poison-1");
      expect(entry?.error).toContain("Lease expired");
      expect(entry?.failures).toHaveLength(2);
    });

    it("deadLetter() releases the lease it owns and stores the failure history", async () => {
      const queue = makeQueue();
      await queue.push(message("dl-1"));
      const msg = await queue.pop();

      await queue.deadLetter(
        {
          message: msg as QueueMessage,
          error: "final failure",
          failures: [{ attempt: 0, error: "final failure", failedAt: Date.now() }],
          deadLetteredAt: Date.now(),
        },
        msg?.leaseToken,
      );

      expect(await queue.inFlightSize()).toBe(0);
      expect(await queue.deadLetterSize()).toBe(1);
      const [entry] = await queue.listDeadLetters();
      expect(entry?.error).toBe("final failure");
      expect(entry?.failures).toHaveLength(1);
    });

    it("re-drives a single dead-lettered job with a clean retry budget", async () => {
      const queue = makeQueue();
      await queue.deadLetter({
        message: message("redrive-1", { attempt: 4 }),
        error: "boom",
        failures: [],
        deadLetteredAt: Date.now(),
      });

      expect(await queue.redriveDeadLetter("nope")).toBe(false);
      expect(await queue.redriveDeadLetter("redrive-1")).toBe(true);
      expect(await queue.deadLetterSize()).toBe(0);

      const popped = await queue.pop();
      expect(popped?.id).toBe("redrive-1");
      expect(popped?.attempt).toBe(0);
    });

    it("re-drives in bulk and purges", async () => {
      const queue = makeQueue();
      for (const id of ["d1", "d2", "d3"]) {
        await queue.deadLetter({
          message: message(id),
          error: "boom",
          failures: [],
          deadLetteredAt: Date.now(),
        });
      }

      expect(await queue.redriveDeadLetters(2)).toBe(2);
      expect(await queue.size()).toBe(2);
      expect(await queue.deadLetterSize()).toBe(1);
      expect(await queue.purgeDeadLetters()).toBe(1);
      expect(await queue.deadLetterSize()).toBe(0);
    });

    it("concurrent re-drives of the same job produce exactly one re-queue", async () => {
      const a = makeQueue();
      const b = makeQueue();
      await a.deadLetter({
        message: message("dup-redrive"),
        error: "boom",
        failures: [],
        deadLetteredAt: Date.now(),
      });

      const results = await Promise.all([a.redriveDeadLetter("dup-redrive"), b.redriveDeadLetter("dup-redrive")]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await a.size()).toBe(1);
    });
  });
});

describe("RedisQueue construction", () => {
  it("accepts a URL option without connecting", () => {
    expect(new RedisQueue({ url: "redis://localhost:6379" })).toBeDefined();
  });

  it("accepts a custom prefix", () => {
    expect(new RedisQueue({ prefix: "my-app:queue" })).toBeDefined();
  });

  it("exposes its visibility timeout so the task worker can validate task timeouts", () => {
    expect(new RedisQueue({ visibilityTimeout: 45_000 }).visibilityTimeoutMs).toBe(45_000);
    expect(new RedisQueue().visibilityTimeoutMs).toBe(30_000);
  });
});
