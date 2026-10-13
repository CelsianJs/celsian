// @celsian/adapter-cloudflare, request.ip comes from CF-Connecting-IP

import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { createCloudflareHandler } from "../src/index.js";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

function ipApp() {
  const app = createApp();
  app.get("/ip", (req) => ({ ip: req.ip ?? null }));
  return app;
}

describe("@celsian/adapter-cloudflare request.ip", () => {
  it("is the client address Cloudflare's edge recorded", async () => {
    const request = new Request("https://api.example.com/ip", {
      headers: { "cf-connecting-ip": "198.51.100.22", "x-forwarded-for": "6.6.6.6" },
    });

    const res = await createCloudflareHandler(ipApp()).fetch(request, {}, ctx);

    expect(await res.json()).toEqual({ ip: "198.51.100.22" });
  });

  it("is undefined without the header", async () => {
    const res = await createCloudflareHandler(ipApp()).fetch(new Request("https://api.example.com/ip"), {}, ctx);

    expect(await res.json()).toEqual({ ip: null });
  });
});
