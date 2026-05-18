import { WSRegistry } from "@celsian/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedisWSAdapter } from "../src/index.js";

/**
 * Create a mock ioredis client with pub/sub support.
 * The messageHandler callback simulates receiving Redis messages.
 */
function createMockRedis() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const subscriptions = new Set<string>();

  return {
    instance: {
      publish: vi.fn().mockResolvedValue(1),
      subscribe: vi.fn().mockImplementation((...channels: string[]) => {
        for (const ch of channels) subscriptions.add(ch);
        return Promise.resolve();
      }),
      unsubscribe: vi.fn().mockImplementation((...channels: string[]) => {
        for (const ch of channels) subscriptions.delete(ch);
        return Promise.resolve();
      }),
      on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        const existing = listeners.get(event) ?? [];
        existing.push(handler);
        listeners.set(event, existing);
      }),
      quit: vi.fn().mockResolvedValue("OK"),
    },
    subscriptions,
    /** Simulate receiving a message from Redis */
    simulateMessage(channel: string, message: string) {
      const handlers = listeners.get("message") ?? [];
      for (const h of handlers) {
        h(channel, message);
      }
    },
  };
}

function createMockWSConnection(id: string) {
  return {
    id,
    send: vi.fn(),
    close: vi.fn(),
    metadata: {},
  };
}

describe("RedisWSAdapter", () => {
  let pub: ReturnType<typeof createMockRedis>;
  let sub: ReturnType<typeof createMockRedis>;
  let registry: WSRegistry;
  let adapter: RedisWSAdapter;

  beforeEach(() => {
    pub = createMockRedis();
    sub = createMockRedis();
    registry = new WSRegistry();

    adapter = new RedisWSAdapter(registry, {
      publisher: pub.instance as any,
      subscriber: sub.instance as any,
    });
  });

  it("should publish broadcasts to Redis channel", async () => {
    registry.register("/chat", {});
    await adapter.subscribePath("/chat");

    await adapter.broadcast("/chat", "hello world");

    expect(pub.instance.publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = pub.instance.publish.mock.calls[0] as [string, string];
    expect(channel).toBe("ws:/chat");

    const parsed = JSON.parse(payload);
    expect(parsed.data).toBe("hello world");
    expect(parsed.binary).toBe(false);
    expect(parsed.path).toBe("/chat");
    expect(parsed.nodeId).toBe(adapter.nodeId);
  });

  it("should subscribe to Redis channel for path", async () => {
    await adapter.subscribePath("/notifications");

    expect(sub.instance.subscribe).toHaveBeenCalledWith("ws:/notifications");
  });

  it("should not double-subscribe to the same path", async () => {
    await adapter.subscribePath("/chat");
    await adapter.subscribePath("/chat");

    expect(sub.instance.subscribe).toHaveBeenCalledTimes(1);
  });

  it("should receive and forward messages from Redis subscription", async () => {
    registry.register("/chat", {});
    const conn = createMockWSConnection("ws-1");
    registry.addConnection("/chat", conn);

    await adapter.subscribePath("/chat");

    // Simulate a message from another node
    const msg = JSON.stringify({
      nodeId: "other-node",
      path: "/chat",
      data: "remote message",
      binary: false,
    });
    sub.simulateMessage("ws:/chat", msg);

    expect(conn.send).toHaveBeenCalledWith("remote message");
  });

  it("should skip messages from own node (no echo)", async () => {
    registry.register("/chat", {});
    const conn = createMockWSConnection("ws-1");
    registry.addConnection("/chat", conn);

    await adapter.subscribePath("/chat");

    // Simulate a message from THIS node
    const msg = JSON.stringify({
      nodeId: adapter.nodeId,
      path: "/chat",
      data: "my own message",
      binary: false,
    });
    sub.simulateMessage("ws:/chat", msg);

    // Should NOT forward — already sent locally
    expect(conn.send).not.toHaveBeenCalled();
  });

  it("should route messages to correct per-path channels", async () => {
    registry.register("/chat", {});
    registry.register("/alerts", {});

    const chatConn = createMockWSConnection("chat-1");
    const alertConn = createMockWSConnection("alert-1");
    registry.addConnection("/chat", chatConn);
    registry.addConnection("/alerts", alertConn);

    await adapter.subscribePath("/chat");
    await adapter.subscribePath("/alerts");

    // Simulate message on /chat channel from another node
    sub.simulateMessage(
      "ws:/chat",
      JSON.stringify({ nodeId: "other", path: "/chat", data: "chat msg", binary: false }),
    );

    // Simulate message on /alerts channel from another node
    sub.simulateMessage(
      "ws:/alerts",
      JSON.stringify({ nodeId: "other", path: "/alerts", data: "alert msg", binary: false }),
    );

    expect(chatConn.send).toHaveBeenCalledWith("chat msg");
    expect(alertConn.send).toHaveBeenCalledWith("alert msg");

    // Each connection should only have received its own path's message
    expect(chatConn.send).toHaveBeenCalledTimes(1);
    expect(alertConn.send).toHaveBeenCalledTimes(1);
  });

  it("should handle connection cleanup on disconnect", async () => {
    registry.register("/chat", {});
    const conn = createMockWSConnection("ws-cleanup");
    adapter.addConnection("/chat", conn);

    expect(adapter.getConnectionCount("/chat")).toBe(1);

    adapter.removeConnection("/chat", conn);

    expect(adapter.getConnectionCount("/chat")).toBe(0);
  });

  it("should also broadcast locally when calling broadcast()", async () => {
    registry.register("/chat", {});
    const conn = createMockWSConnection("local-1");
    registry.addConnection("/chat", conn);

    await adapter.subscribePath("/chat");
    await adapter.broadcast("/chat", "local+remote");

    // Local connection should receive the message directly
    expect(conn.send).toHaveBeenCalledWith("local+remote");
  });

  it("should respect exclude parameter in broadcast", async () => {
    registry.register("/chat", {});
    const conn1 = createMockWSConnection("ws-a");
    const conn2 = createMockWSConnection("ws-b");
    registry.addConnection("/chat", conn1);
    registry.addConnection("/chat", conn2);

    await adapter.subscribePath("/chat");
    await adapter.broadcast("/chat", "hello", "ws-a");

    // conn1 (ws-a) should be excluded
    expect(conn1.send).not.toHaveBeenCalled();
    expect(conn2.send).toHaveBeenCalledWith("hello");

    // Check that exclude is passed in the Redis message
    const payload = JSON.parse(pub.instance.publish.mock.calls[0][1] as string);
    expect(payload.exclude).toBe("ws-a");
  });

  it("should handle binary data via base64 encoding", async () => {
    registry.register("/binary", {});
    const conn = createMockWSConnection("bin-1");
    registry.addConnection("/binary", conn);

    await adapter.subscribePath("/binary");

    const binaryData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]).buffer;
    await adapter.broadcast("/binary", binaryData);

    // Check the Redis message has binary flag
    const payload = JSON.parse(pub.instance.publish.mock.calls[0][1] as string);
    expect(payload.binary).toBe(true);
    expect(typeof payload.data).toBe("string"); // base64 string
  });

  it("should close cleanly and unsubscribe", async () => {
    await adapter.subscribePath("/chat");
    await adapter.subscribePath("/alerts");

    await adapter.close();

    expect(sub.instance.unsubscribe).toHaveBeenCalled();
  });

  it("should handle malformed Redis messages gracefully", async () => {
    registry.register("/chat", {});
    const conn = createMockWSConnection("ws-1");
    registry.addConnection("/chat", conn);

    await adapter.subscribePath("/chat");

    // Should not throw
    sub.simulateMessage("ws:/chat", "not valid json{{{");

    expect(conn.send).not.toHaveBeenCalled();
  });
});
