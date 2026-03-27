import { describe, expect, it, vi } from "vitest";
import { createRPCClient, RPCError } from "../src/client.js";

describe("createRPCClient", () => {
  it("should make query requests via GET", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ result: { message: "Hello!" } }),
    });

    const client = createRPCClient<any>({
      baseUrl: "http://localhost:3000/_rpc",
      fetch: mockFetch as any,
    });

    const result = await client.greeting.hello.query({ name: "World" });
    expect(result).toEqual({ message: "Hello!" });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const callUrl = mockFetch.mock.calls[0][0];
    expect(callUrl).toContain("/_rpc/greeting.hello");
  });

  it("should make mutation requests via POST", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ result: { id: 1 } }),
    });

    const client = createRPCClient<any>({
      baseUrl: "http://localhost:3000/_rpc",
      fetch: mockFetch as any,
    });

    const result = await client.users.create.mutate({ name: "Alice" });
    expect(result).toEqual({ id: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3000/_rpc/users.create");
    expect(opts.method).toBe("POST");
  });

  it("should throw RPCError on error response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ error: { message: "Not found", code: "NOT_FOUND" } }),
    });

    const client = createRPCClient<any>({
      fetch: mockFetch as any,
    });

    await expect(client.test.query()).rejects.toThrow(RPCError);
  });

  it("should include custom headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ result: null }),
    });

    const client = createRPCClient<any>({
      fetch: mockFetch as any,
      headers: { Authorization: "Bearer token123" },
    });

    await client.test.query();
    const opts = mockFetch.mock.calls[0][1];
    expect(opts.headers.Authorization).toBe("Bearer token123");
  });

  it("should not trigger .then accidentally", () => {
    const client = createRPCClient<any>({
      fetch: (() => {}) as any,
    });

    // Accessing .then should return undefined (not trigger promise resolution)
    expect((client as any).then).toBeUndefined();
  });
});

describe("RPCError", () => {
  it("should create error with code and message", () => {
    const err = new RPCError({ message: "Test", code: "TEST_ERROR" });
    expect(err.message).toBe("Test");
    expect(err.code).toBe("TEST_ERROR");
    expect(err.name).toBe("RPCError");
  });

  it("should include issues", () => {
    const err = new RPCError({
      message: "Validation failed",
      code: "VALIDATION_ERROR",
      issues: [{ message: "Required", path: ["name"] }],
    });
    expect(err.issues).toHaveLength(1);
  });
});
