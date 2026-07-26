// @celsian/core, MemoryQueue lease, redelivery and dead-letter semantics

import { describe, expect, it } from "vitest";
import { MemoryQueue, type QueueMessage } from "../src/queue.js";

function makeMessage(id: string, overrides: Partial<QueueMessage> = {}): QueueMessage {
  return {
    id,
    taskName: "t",
    input: { n: 1 },
    attempt: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    availableAt: Date.now(),
    deliveries: 0,
    failures: [],
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MemoryQueue at-least-once delivery", () => {
  it("redelivers a message whose lease expired without an ack", async () => {
    // Regression: popped messages used to move to inFlight and stay there
    // forever, nothing reclaimed them, making the DEFAULT backend at-most-once.
    const queue = new MemoryQueue({ visibilityTimeout: 50 });
    await queue.push(makeMessage("lease-1"));

    const first = await queue.pop();
    expect(first?.id).toBe("lease-1");
    expect(await queue.inFlightSize()).toBe(1);

    // Simulate the worker dying: never ack.
    await sleep(80);

    const redelivered = await queue.pop();
    expect(redelivered?.id).toBe("lease-1");
    expect(redelivered?.deliveries).toBe(2);
    // The lease expiry drew down the retry budget and was recorded.
    expect(redelivered?.attempt).toBe(1);
    expect(redelivered?.failures?.[0]?.error).toContain("Lease expired");
  });

  it("gives each delivery a distinct lease token", async () => {
    const queue = new MemoryQueue({ visibilityTimeout: 50 });
    await queue.push(makeMessage("token-1"));

    const first = await queue.pop();
    await sleep(80);
    const second = await queue.pop();

    expect(first?.leaseToken).toBeTruthy();
    expect(second?.leaseToken).toBeTruthy();
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
  });

  it("a stale lease cannot ack away the delivery another worker now owns", async () => {
    // Regression: reclaim reused the same job id, so the slow worker's ack
    // deleted the in-flight entry belonging to the worker that took over.
    const queue = new MemoryQueue({ visibilityTimeout: 50 });
    await queue.push(makeMessage("overlap-1"));

    const workerA = await queue.pop();
    await sleep(80);
    const workerB = await queue.pop();
    expect(workerB?.id).toBe(workerA?.id);
    expect(await queue.inFlightSize()).toBe(1);

    // Worker A finally finishes and acks with its now-stale token.
    await queue.ack("overlap-1", workerA?.leaseToken);
    expect(await queue.inFlightSize()).toBe(1);

    // Worker B still owns the message and can complete it.
    await queue.ack("overlap-1", workerB?.leaseToken);
    expect(await queue.inFlightSize()).toBe(0);
  });

  it("a stale lease cannot nack away the delivery another worker now owns", async () => {
    const queue = new MemoryQueue({ visibilityTimeout: 50 });
    await queue.push(makeMessage("overlap-2"));

    const workerA = await queue.pop();
    await sleep(80);
    const workerB = await queue.pop();

    await queue.nack("overlap-2", 0, workerA?.leaseToken);
    // Still leased to B, not back on the pending list.
    expect(await queue.inFlightSize()).toBe(1);
    expect(await queue.size()).toBe(0);

    await queue.nack("overlap-2", 0, workerB?.leaseToken);
    expect(await queue.size()).toBe(1);
  });

  it("extend() holds the lease for a long-running task, and fails for a stale token", async () => {
    const queue = new MemoryQueue({ visibilityTimeout: 60 });
    await queue.push(makeMessage("heartbeat-1"));

    const msg = await queue.pop();
    const token = msg?.leaseToken as string;

    // Heartbeat across three visibility windows.
    for (let i = 0; i < 3; i++) {
      await sleep(40);
      expect(await queue.extend("heartbeat-1", token)).toBe(true);
    }
    // Never reclaimed while heartbeating.
    expect(await queue.pop()).toBeNull();
    expect(await queue.inFlightSize()).toBe(1);

    expect(await queue.extend("heartbeat-1", "not-my-token")).toBe(false);
  });
});

describe("MemoryQueue dead-letter queue", () => {
  it("dead-letters a message that keeps outliving its lease instead of looping forever", async () => {
    const queue = new MemoryQueue({ visibilityTimeout: 30 });
    await queue.push(makeMessage("poison-1", { maxRetries: 1 }));

    // Delivery 1 and 2 both abandoned; the retry budget is 1.
    await queue.pop();
    await sleep(50);
    await queue.pop();
    await sleep(50);
    expect(await queue.pop()).toBeNull();

    expect(await queue.deadLetterSize()).toBe(1);
    const [entry] = await queue.listDeadLetters();
    expect(entry?.message.id).toBe("poison-1");
    expect(entry?.error).toContain("Lease expired");
    expect(entry?.failures.length).toBe(2);
  });

  it("re-drives a single dead-lettered job with a clean retry budget", async () => {
    const queue = new MemoryQueue({ visibilityTimeout: 20 });
    const message = makeMessage("redrive-1", { maxRetries: 0 });
    await queue.deadLetter({
      message,
      error: "boom",
      failures: [{ attempt: 0, error: "boom", failedAt: Date.now() }],
      deadLetteredAt: Date.now(),
    });

    expect(await queue.redriveDeadLetter("nope")).toBe(false);
    expect(await queue.redriveDeadLetter("redrive-1")).toBe(true);
    expect(await queue.deadLetterSize()).toBe(0);

    const popped = await queue.pop();
    expect(popped?.id).toBe("redrive-1");
    expect(popped?.attempt).toBe(0);
  });

  it("re-drives and purges in bulk", async () => {
    const queue = new MemoryQueue();
    for (const id of ["d1", "d2", "d3"]) {
      await queue.deadLetter({
        message: makeMessage(id),
        error: "boom",
        failures: [],
        deadLetteredAt: Date.now(),
      });
    }

    expect(await queue.redriveDeadLetters(2)).toBe(2);
    expect(await queue.size()).toBe(2);
    expect(await queue.purgeDeadLetters()).toBe(1);
    expect(await queue.deadLetterSize()).toBe(0);
  });

  it("deadLetter() releases the in-flight entry it owns", async () => {
    const queue = new MemoryQueue();
    await queue.push(makeMessage("dl-inflight"));
    const msg = await queue.pop();

    await queue.deadLetter(
      { message: msg as QueueMessage, error: "final", failures: [], deadLetteredAt: Date.now() },
      msg?.leaseToken,
    );

    expect(await queue.inFlightSize()).toBe(0);
    expect(await queue.deadLetterSize()).toBe(1);
  });
});
