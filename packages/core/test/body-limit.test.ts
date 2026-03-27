import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("Body Size Limits", () => {
  it("should reject body exceeding content-length limit", async () => {
    const app = createApp({ bodyLimit: 100 });
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody }));

    const largeBody = JSON.stringify({ data: "x".repeat(200) });
    const response = await app.inject({
      method: "POST",
      url: "/data",
      headers: {
        "content-type": "application/json",
        "content-length": String(largeBody.length),
      },
      payload: JSON.parse(largeBody),
    });
    expect(response.status).toBe(413);
  });

  it("should accept body within limit", async () => {
    const app = createApp({ bodyLimit: 10000 });
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody }));

    const response = await app.inject({
      method: "POST",
      url: "/data",
      payload: { message: "hello" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.received).toEqual({ message: "hello" });
  });

  it("should use 1MB default limit", async () => {
    const app = createApp();
    app.post("/data", (_req, reply) => reply.json({ received: true }));

    // Small body should work
    const response = await app.inject({
      method: "POST",
      url: "/data",
      payload: { message: "hello" },
    });
    expect(response.status).toBe(200);
  });

  it("should allow disabling body limit with 0", async () => {
    const app = createApp({ bodyLimit: 0 });
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody }));

    const response = await app.inject({
      method: "POST",
      url: "/data",
      payload: { message: "hello" },
    });
    expect(response.status).toBe(200);
  });
});
