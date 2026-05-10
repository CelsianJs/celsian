import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { buildRequest } from "../src/request.js";
import type { CelsianRequest } from "../src/types.js";

describe("WebSocket Upgrade Hooks", () => {
  function makeUpgradeRequest(headers: Record<string, string> = {}): CelsianRequest {
    const url = new URL("http://localhost/chat");
    const raw = new Request(url.toString(), {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        ...headers,
      },
    });
    return buildRequest(raw, url, {});
  }

  it("should allow connections when no upgrade hooks are registered", async () => {
    const app = createApp({ security: false });
    const handler = { open: () => {} };
    app.ws("/chat", handler);

    const req = makeUpgradeRequest();
    const allowed = await app.runWsUpgradeHooks(req, handler);
    expect(allowed).toBe(true);
  });

  it("should reject connections when global hook returns false", async () => {
    const app = createApp({ security: false });
    const handler = { open: () => {} };
    app.ws("/chat", handler);

    app.onWsUpgrade(() => false);

    const req = makeUpgradeRequest();
    const allowed = await app.runWsUpgradeHooks(req, handler);
    expect(allowed).toBe(false);
  });

  it("should reject connections when global hook throws", async () => {
    const app = createApp({ security: false });
    const handler = { open: () => {} };
    app.ws("/chat", handler);

    app.onWsUpgrade(() => {
      throw new Error("Unauthorized");
    });

    const req = makeUpgradeRequest();
    const allowed = await app.runWsUpgradeHooks(req, handler);
    expect(allowed).toBe(false);
  });

  it("should allow connections when global hook returns void", async () => {
    const app = createApp({ security: false });
    const handler = { open: () => {} };
    app.ws("/chat", handler);

    app.onWsUpgrade(() => {
      // Allow by not returning false
    });

    const req = makeUpgradeRequest();
    const allowed = await app.runWsUpgradeHooks(req, handler);
    expect(allowed).toBe(true);
  });

  it("should run per-handler onUpgrade hook", async () => {
    const app = createApp({ security: false });
    const handler = {
      onUpgrade: () => false as const,
      open: () => {},
    };
    app.ws("/chat", handler);

    const req = makeUpgradeRequest();
    const allowed = await app.runWsUpgradeHooks(req, handler);
    expect(allowed).toBe(false);
  });

  it("should run global hooks before per-handler hooks", async () => {
    const app = createApp({ security: false });
    const order: string[] = [];

    app.onWsUpgrade(() => {
      order.push("global");
    });

    const handler = {
      onUpgrade: () => {
        order.push("per-handler");
      },
      open: () => {},
    };
    app.ws("/chat", handler);

    const req = makeUpgradeRequest();
    const allowed = await app.runWsUpgradeHooks(req, handler);
    expect(allowed).toBe(true);
    expect(order).toEqual(["global", "per-handler"]);
  });

  it("should skip per-handler hook if global hook rejects", async () => {
    const app = createApp({ security: false });
    const order: string[] = [];

    app.onWsUpgrade(() => {
      order.push("global");
      return false;
    });

    const handler = {
      onUpgrade: () => {
        order.push("per-handler");
      },
      open: () => {},
    };
    app.ws("/chat", handler);

    const req = makeUpgradeRequest();
    const allowed = await app.runWsUpgradeHooks(req, handler);
    expect(allowed).toBe(false);
    expect(order).toEqual(["global"]);
  });

  it("should support async upgrade hooks with auth pattern", async () => {
    const app = createApp({ security: false });

    // Simulate JWT auth check
    app.onWsUpgrade(async (req) => {
      const token = req.headers.get("authorization")?.replace("Bearer ", "");
      if (!token || token !== "valid-token") return false;
      // Attach user info to request
      (req as Record<string, unknown>).user = { id: "123", name: "Test" };
    });

    const handler = { open: () => {} };
    app.ws("/chat", handler);

    // Without token
    const badReq = makeUpgradeRequest();
    expect(await app.runWsUpgradeHooks(badReq, handler)).toBe(false);

    // With valid token
    const goodReq = makeUpgradeRequest({ authorization: "Bearer valid-token" });
    expect(await app.runWsUpgradeHooks(goodReq, handler)).toBe(true);
    expect((goodReq as Record<string, unknown>).user).toEqual({ id: "123", name: "Test" });
  });

  it("should support multiple global hooks (all must pass)", async () => {
    const app = createApp({ security: false });

    app.onWsUpgrade((req) => {
      // Check origin
      const origin = req.headers.get("origin");
      if (origin && origin !== "http://allowed.com") return false;
    });

    app.onWsUpgrade((req) => {
      // Check token
      const token = req.headers.get("authorization");
      if (!token) return false;
    });

    const handler = { open: () => {} };
    app.ws("/chat", handler);

    // Missing both
    const req1 = makeUpgradeRequest();
    expect(await app.runWsUpgradeHooks(req1, handler)).toBe(false);

    // Good origin, missing token
    const req2 = makeUpgradeRequest({ origin: "http://allowed.com" });
    expect(await app.runWsUpgradeHooks(req2, handler)).toBe(false);

    // Good both
    const req3 = makeUpgradeRequest({ origin: "http://allowed.com", authorization: "Bearer tok" });
    expect(await app.runWsUpgradeHooks(req3, handler)).toBe(true);
  });
});
