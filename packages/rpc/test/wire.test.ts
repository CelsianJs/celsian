import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/wire.js";

describe("Wire protocol", () => {
  it("should pass through primitives", () => {
    expect(encode(null)).toBe(null);
    expect(encode(true)).toBe(true);
    expect(encode(42)).toBe(42);
    expect(encode("hello")).toBe("hello");

    expect(decode(null)).toBe(null);
    expect(decode(true)).toBe(true);
    expect(decode(42)).toBe(42);
    expect(decode("hello")).toBe("hello");
  });

  it("should encode/decode undefined", () => {
    const encoded = encode(undefined);
    expect(encoded).toEqual({ __t: "Undefined", v: "" });
    expect(decode(encoded)).toBeUndefined();
  });

  it("should encode/decode Date", () => {
    const date = new Date("2026-01-15T10:00:00Z");
    const encoded = encode(date);
    expect((encoded as any).__t).toBe("Date");
    const decoded = decode(encoded);
    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).toISOString()).toBe("2026-01-15T10:00:00.000Z");
  });

  it("should encode/decode BigInt", () => {
    const encoded = encode(BigInt(123456789));
    expect((encoded as any).__t).toBe("BigInt");
    const decoded = decode(encoded);
    expect(decoded).toBe(BigInt(123456789));
  });

  it("should encode/decode Set", () => {
    const set = new Set([1, 2, 3]);
    const encoded = encode(set);
    const decoded = decode(encoded) as Set<number>;
    expect(decoded).toBeInstanceOf(Set);
    expect(decoded.size).toBe(3);
    expect(decoded.has(1)).toBe(true);
    expect(decoded.has(2)).toBe(true);
    expect(decoded.has(3)).toBe(true);
  });

  it("should encode/decode Map", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const encoded = encode(map);
    const decoded = decode(encoded) as Map<string, number>;
    expect(decoded).toBeInstanceOf(Map);
    expect(decoded.get("a")).toBe(1);
    expect(decoded.get("b")).toBe(2);
  });

  it("should encode/decode RegExp", () => {
    const regex = /hello/gi;
    const encoded = encode(regex);
    const decoded = decode(encoded) as RegExp;
    expect(decoded).toBeInstanceOf(RegExp);
    expect(decoded.source).toBe("hello");
    expect(decoded.flags).toBe("gi");
  });

  it("should encode/decode arrays recursively", () => {
    const input = [1, new Date("2026-01-01"), "hello"];
    const encoded = encode(input);
    const decoded = decode(encoded) as unknown[];
    expect(decoded[0]).toBe(1);
    expect(decoded[1]).toBeInstanceOf(Date);
    expect(decoded[2]).toBe("hello");
  });

  it("should encode/decode objects recursively", () => {
    const input = {
      name: "test",
      createdAt: new Date("2026-01-01"),
      count: 42,
    };
    const encoded = encode(input);
    const decoded = decode(encoded) as Record<string, unknown>;
    expect(decoded.name).toBe("test");
    expect(decoded.createdAt).toBeInstanceOf(Date);
    expect(decoded.count).toBe(42);
  });

  it("should roundtrip complex nested structures", () => {
    const input = {
      users: [
        { name: "Alice", joined: new Date("2025-01-01") },
        { name: "Bob", joined: new Date("2026-01-01") },
      ],
      meta: { total: 2 },
    };
    const decoded = decode(encode(input)) as any;
    expect(decoded.users[0].name).toBe("Alice");
    expect(decoded.users[0].joined).toBeInstanceOf(Date);
    expect(decoded.meta.total).toBe(2);
  });
});
