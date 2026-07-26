import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { json } from "./helpers/json.js";

describe("Health Check", () => {
  it("should register /health and /ready endpoints", async () => {
    const app = createApp();
    app.health();

    const healthResponse = await app.inject({ url: "/health" });
    expect(healthResponse.status).toBe(200);
    const healthBody = await json<{ status: string; timestamp: string }>(healthResponse);
    expect(healthBody.status).toBe("ok");
    expect(healthBody.timestamp).toBeDefined();

    const readyResponse = await app.inject({ url: "/ready" });
    expect(readyResponse.status).toBe(200);
    const readyBody = await json<{ status: string }>(readyResponse);
    expect(readyBody.status).toBe("ready");
  });

  it("should use custom paths", async () => {
    const app = createApp();
    app.health({ path: "/healthz", readyPath: "/readyz" });

    const response = await app.inject({ url: "/healthz" });
    expect(response.status).toBe(200);

    const ready = await app.inject({ url: "/readyz" });
    expect(ready.status).toBe(200);
  });

  it("should support custom health check function", async () => {
    let healthy = true;
    const app = createApp();
    app.health({ check: () => healthy });

    const response1 = await app.inject({ url: "/health" });
    expect(response1.status).toBe(200);

    healthy = false;
    const response2 = await app.inject({ url: "/health" });
    expect(response2.status).toBe(503);
    const body = await json<{ status: string }>(response2);
    expect(body.status).toBe("unhealthy");
  });

  it("should support async health check function", async () => {
    const app = createApp();
    app.health({
      check: async () => {
        // Simulate a DB ping
        await new Promise((r) => setTimeout(r, 10));
        return true;
      },
    });

    const response = await app.inject({ url: "/health" });
    expect(response.status).toBe(200);
  });
});
