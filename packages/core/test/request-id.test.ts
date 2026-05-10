import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("requestId generation", () => {
  it("should generate requestId even without logger enabled", async () => {
    const app = createApp({ logger: false });
    let capturedId: string | undefined;

    app.get("/test", (req, reply) => {
      capturedId = (req as Record<string, unknown>).requestId as string;
      return reply.json({ ok: true });
    });

    await app.handle(new Request("http://localhost/test"));
    expect(capturedId).toBeTruthy();
    expect(typeof capturedId).toBe("string");
  });

  it("should generate requestId with logger enabled", async () => {
    const app = createApp({ logger: true });
    let capturedId: string | undefined;

    app.get("/test", (req, reply) => {
      capturedId = (req as Record<string, unknown>).requestId as string;
      return reply.json({ ok: true });
    });

    await app.handle(new Request("http://localhost/test"));
    expect(capturedId).toBeTruthy();
    expect(typeof capturedId).toBe("string");
  });

  it("should generate unique requestIds per request", async () => {
    const app = createApp();
    const ids: string[] = [];

    app.get("/test", (req, reply) => {
      ids.push((req as Record<string, unknown>).requestId as string);
      return reply.json({ ok: true });
    });

    await app.handle(new Request("http://localhost/test"));
    await app.handle(new Request("http://localhost/test"));
    await app.handle(new Request("http://localhost/test"));

    expect(ids.length).toBe(3);
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });
});
