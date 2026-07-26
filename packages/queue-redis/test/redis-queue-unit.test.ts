// @celsian/queue-redis — client-ownership and error-handling unit tests
//
// There is deliberately NO in-memory fake of Redis here any more. The previous
// fake hand-reimplemented the Lua scripts in JavaScript, so the real Lua in
// src/index.ts was executed by nothing and the fake happily "passed" while the
// shipped promoteDelayed was non-atomic. All queue behaviour is now verified
// against a real Redis in redis-queue.test.ts; this file only covers wiring
// that involves no Redis commands at all.

import { describe, expect, it, vi } from "vitest";
import { RedisQueue } from "../src/index.js";

/** Captures instances created via `new Redis(...)` so we can inspect their listeners. */
const ownedInstances: Array<{ on: ReturnType<typeof vi.fn>; status: string }> = [];

vi.mock("ioredis", () => {
  return {
    default: class {
      constructor() {
        const stub = { on: vi.fn(), status: "wait" };
        ownedInstances.push(stub);
        // biome-ignore lint/correctness/noConstructorReturn: test double returns the stub
        return stub as unknown as object;
      }
    },
  };
});

describe("RedisQueue client ownership", () => {
  it("does NOT attach an 'error' listener to a caller-owned client", () => {
    const external = { on: vi.fn(), status: "ready" };
    new RedisQueue({ client: external as never });
    expect(external.on).not.toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("attaches an 'error' listener to an owned client and routes errors to onError", () => {
    ownedInstances.length = 0;
    const onError = vi.fn();
    new RedisQueue({ url: "redis://localhost:6379", onError });

    expect(ownedInstances).toHaveLength(1);
    const errCall = ownedInstances[0]?.on.mock.calls.find((c) => c[0] === "error");
    expect(errCall).toBeDefined();

    // Invoking the registered handler (as ioredis would on a connection error)
    // must be handled gracefully — it routes to onError, never throwing.
    const handler = errCall?.[1] as (e: Error) => void;
    expect(() => handler(new Error("ECONNREFUSED"))).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("falls back to console.error when no onError is supplied", () => {
    ownedInstances.length = 0;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    new RedisQueue({ url: "redis://localhost:6379" });

    const handler = ownedInstances[0]?.on.mock.calls.find((c) => c[0] === "error")?.[1] as (e: Error) => void;
    handler(new Error("ECONNREFUSED"));

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[celsian:queue-redis]"), "ECONNREFUSED");
    consoleError.mockRestore();
  });
});
