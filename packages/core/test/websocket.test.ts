import { describe, expect, it } from "vitest";
import { createWSConnection, WSRegistry } from "../src/websocket.js";

describe("WSRegistry", () => {
  it("should register handlers", () => {
    const registry = new WSRegistry();
    registry.register("/chat", {
      open: () => {},
      message: () => {},
    });

    expect(registry.hasPath("/chat")).toBe(true);
    expect(registry.hasPath("/other")).toBe(false);
  });

  it("should get handlers", () => {
    const registry = new WSRegistry();
    const handler = { open: () => {}, message: () => {} };
    registry.register("/chat", handler);

    expect(registry.getHandler("/chat")).toBe(handler);
    expect(registry.getHandler("/other")).toBeUndefined();
  });

  it("should track connections", () => {
    const registry = new WSRegistry();
    registry.register("/chat", {});

    const ws = createWSConnection({
      send: () => {},
      close: () => {},
    });

    registry.addConnection("/chat", ws);
    expect(registry.getConnectionCount("/chat")).toBe(1);
    expect(registry.getConnectionCount()).toBe(1);

    registry.removeConnection("/chat", ws);
    expect(registry.getConnectionCount("/chat")).toBe(0);
  });

  it("should broadcast to connections", () => {
    const registry = new WSRegistry();
    registry.register("/chat", {});

    const sent: string[] = [];
    const ws1 = createWSConnection({
      send: (data) => sent.push(data as string),
      close: () => {},
    });
    const ws2 = createWSConnection({
      send: (data) => sent.push(data as string),
      close: () => {},
    });

    registry.addConnection("/chat", ws1);
    registry.addConnection("/chat", ws2);

    registry.broadcast("/chat", "hello");
    expect(sent).toEqual(["hello", "hello"]);
  });

  it("should broadcast with exclusion", () => {
    const registry = new WSRegistry();
    registry.register("/chat", {});

    const sent: string[] = [];
    const ws1 = createWSConnection({
      send: (data) => sent.push(`ws1:${data}`),
      close: () => {},
    });
    const ws2 = createWSConnection({
      send: (data) => sent.push(`ws2:${data}`),
      close: () => {},
    });

    registry.addConnection("/chat", ws1);
    registry.addConnection("/chat", ws2);

    registry.broadcast("/chat", "hello", ws1.id);
    expect(sent).toEqual(["ws2:hello"]);
  });

  it("should broadcast to all paths", () => {
    const registry = new WSRegistry();
    registry.register("/chat", {});
    registry.register("/notifications", {});

    const sent: string[] = [];
    const ws1 = createWSConnection({
      send: (data) => sent.push(`chat:${data}`),
      close: () => {},
    });
    const ws2 = createWSConnection({
      send: (data) => sent.push(`notif:${data}`),
      close: () => {},
    });

    registry.addConnection("/chat", ws1);
    registry.addConnection("/notifications", ws2);

    registry.broadcastAll("system message");
    expect(sent).toEqual(["chat:system message", "notif:system message"]);
  });
});

describe("createWSConnection", () => {
  it("should create connection with unique ID", () => {
    const ws1 = createWSConnection({ send: () => {}, close: () => {} });
    const ws2 = createWSConnection({ send: () => {}, close: () => {} });

    expect(ws1.id).not.toBe(ws2.id);
    expect(ws1.metadata).toEqual({});
  });

  it("should delegate send and close", () => {
    let lastSent = "";
    let closed = false;
    const ws = createWSConnection({
      send: (data) => {
        lastSent = data as string;
      },
      close: () => {
        closed = true;
      },
    });

    ws.send("test");
    expect(lastSent).toBe("test");

    ws.close();
    expect(closed).toBe(true);
  });

  it("should support metadata", () => {
    const ws = createWSConnection({ send: () => {}, close: () => {} });
    ws.metadata.userId = "123";
    expect(ws.metadata.userId).toBe("123");
  });
});

describe("App WebSocket integration", () => {
  it("should register WS handlers via app.ws()", async () => {
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    app.ws("/chat", {
      open: () => {},
      message: () => {},
    });

    expect(app.wsRegistry.hasPath("/chat")).toBe(true);
  });

  it("should broadcast via app.wsBroadcast()", async () => {
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    app.ws("/chat", {});

    const sent: string[] = [];
    const ws = createWSConnection({
      send: (data) => sent.push(data as string),
      close: () => {},
    });

    app.wsRegistry.addConnection("/chat", ws);
    app.wsBroadcast("/chat", "hi");
    expect(sent).toEqual(["hi"]);
  });
});
