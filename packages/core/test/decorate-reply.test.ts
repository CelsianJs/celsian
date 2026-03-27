import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("decorateReply", () => {
  it("should add static value to reply object", async () => {
    const app = createApp();
    app.decorateReply("appName", "celsian");

    app.get("/test", (_req, reply) => {
      return reply.json({ name: (reply as any).appName });
    });

    const response = await app.handle(new Request("http://localhost/test"));
    const body = await response.json();
    expect(body.name).toBe("celsian");
  });

  it("should call factory function per-request for function values", async () => {
    const app = createApp();
    let callCount = 0;
    app.decorateReply("reqNum", () => {
      callCount++;
      return callCount;
    });

    app.get("/test", (_req, reply) => {
      return reply.json({ num: (reply as any).reqNum });
    });

    const r1 = await app.handle(new Request("http://localhost/test"));
    const b1 = await r1.json();
    expect(b1.num).toBe(1);

    const r2 = await app.handle(new Request("http://localhost/test"));
    const b2 = await r2.json();
    expect(b2.num).toBe(2);
  });

  it("should not overwrite built-in reply properties", async () => {
    const app = createApp();
    // 'status' is a built-in method — decoration should not overwrite
    app.decorateReply("status", "custom");

    app.get("/test", (_req, reply) => {
      // status should still be the built-in method
      return reply.status(201).json({ ok: true });
    });

    const response = await app.handle(new Request("http://localhost/test"));
    expect(response.status).toBe(201);
  });

  it("should be available in 404 handler", async () => {
    const app = createApp();
    app.decorateReply("version", "v1");

    app.setNotFoundHandler((_req, reply) => {
      return reply.status(404).json({ version: (reply as any).version, error: "not found" });
    });

    const response = await app.handle(new Request("http://localhost/missing"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.version).toBe("v1");
  });

  it("should work through plugin context", async () => {
    const app = createApp();

    await app.register(
      async (ctx) => {
        ctx.decorateReply("pluginValue", "from-plugin");
        ctx.get("/check", (_req, reply) => {
          return reply.json({ val: (reply as any).pluginValue });
        });
      },
      { encapsulate: false },
    );

    const response = await app.handle(new Request("http://localhost/check"));
    const body = await response.json();
    expect(body.val).toBe("from-plugin");
  });
});
