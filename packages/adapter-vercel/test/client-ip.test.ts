// @celsian/adapter-vercel, request.ip on the Node.js runtime
//
// Vercel's proxy is the peer of a Node function, and it writes the client's
// address to X-Real-IP (overwriting anything the client sent), so an app on
// Vercel sets `clientIp: { header: "x-real-ip" }`.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type CelsianAppOptions, createApp } from "@celsian/core";
import { afterEach, describe, expect, it } from "vitest";
import { createVercelHandler } from "../src/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listen(options: CelsianAppOptions): Promise<string> {
  const app = createApp(options);
  app.get("/ip", (req) => ({ ip: req.ip ?? null }));
  const server = createServer(createVercelHandler(app));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("@celsian/adapter-vercel request.ip", () => {
  it("is the socket's peer address by default", async () => {
    const base = await listen({});

    const res = await fetch(`${base}/ip`, { headers: { "x-real-ip": "6.6.6.6" } });

    expect(await res.json()).toEqual({ ip: "127.0.0.1" });
  });

  it("is the X-Real-IP value when the app trusts it", async () => {
    const base = await listen({ clientIp: { header: "x-real-ip" } });

    const res = await fetch(`${base}/ip`, { headers: { "x-real-ip": "198.51.100.26" } });

    expect(await res.json()).toEqual({ ip: "198.51.100.26" });
  });
});
