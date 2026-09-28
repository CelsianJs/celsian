// @celsian/rate-limit, keying on request.ip when no forwarding header names a client
//
// A request that reaches the app without X-Forwarded-For (a direct connection,
// a health check, an internal caller) used to land in the one shared
// "anonymous" bucket, so a single noisy client exhausted the limit for all of
// them. The connection's peer address is not client-supplied, so it is the key.

import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { type RateLimitOptions, rateLimit } from "../src/index.js";

async function buildApp(options: RateLimitOptions) {
  const app = createApp();
  await app.register(rateLimit(options));
  app.get("/api", () => ({ ok: true }));
  return app;
}

async function burst(
  app: Awaited<ReturnType<typeof buildApp>>,
  n: number,
  remoteAddress: string,
  headers: Record<string, string> = {},
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) {
    statuses.push((await app.inject({ url: "/api", remoteAddress, headers })).status);
  }
  return statuses;
}

describe("rate limit falls back to the connection's address", () => {
  it("gives direct clients their own buckets in trustedProxies mode", async () => {
    const app = await buildApp({ max: 2, window: 60_000, trustedProxies: ["10.0.0.0/8"] });

    expect(await burst(app, 3, "198.51.100.1")).toEqual([200, 200, 429]);
    // A different client is not punished for the first one's traffic.
    expect(await burst(app, 2, "198.51.100.2")).toEqual([200, 200]);
  });

  it("gives direct clients their own buckets in hop-count mode", async () => {
    const app = await buildApp({ max: 1, window: 60_000, trustProxy: true });

    expect(await burst(app, 2, "198.51.100.1")).toEqual([200, 429]);
    expect(await burst(app, 1, "198.51.100.2")).toEqual([200]);
  });

  it("treats two spellings of one address as one client", async () => {
    const app = await buildApp({ max: 1, window: 60_000, trustedProxies: ["10.0.0.0/8"] });

    expect(await burst(app, 1, "198.51.100.1")).toEqual([200]);
    expect(await burst(app, 1, "::ffff:198.51.100.1")).toEqual([429]);
  });

  it("still prefers the address X-Forwarded-For names through a trusted proxy", async () => {
    const app = await buildApp({ max: 1, window: 60_000, trustedProxies: ["10.0.0.0/8"] });

    // Both arrive from the same proxy; the header, not the peer, tells them apart.
    expect(await burst(app, 1, "10.0.0.5", { "x-forwarded-for": "203.0.113.1" })).toEqual([200]);
    expect(await burst(app, 1, "10.0.0.5", { "x-forwarded-for": "203.0.113.2" })).toEqual([200]);
    expect(await burst(app, 1, "10.0.0.5", { "x-forwarded-for": "203.0.113.1" })).toEqual([429]);
  });

  it("keys on the header the app's clientIp setting names", async () => {
    const app = createApp({ clientIp: { header: "fly-client-ip" } });
    await app.register(rateLimit({ max: 1, window: 60_000, keyGenerator: (req) => req.ip ?? "anonymous" }));
    app.get("/api", () => ({ ok: true }));

    const from = (ip: string) =>
      app.inject({ url: "/api", remoteAddress: "172.16.0.9", headers: { "fly-client-ip": ip } });

    expect((await from("203.0.113.1")).status).toBe(200);
    expect((await from("203.0.113.2")).status).toBe(200);
    expect((await from("203.0.113.1")).status).toBe(429);
  });

  it("still shares one bucket when no address is known at all", async () => {
    const app = await buildApp({ max: 1, window: 60_000, trustedProxies: ["10.0.0.0/8"] });

    const statuses = [(await app.inject({ url: "/api" })).status, (await app.inject({ url: "/api" })).status];

    expect(statuses).toEqual([200, 429]);
  });
});
