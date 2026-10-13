// @celsian/adapter-node, request.ip is the socket's peer address

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "@celsian/core";
import { afterEach, describe, expect, it } from "vitest";
import { nodeToWebRequest, writeWebResponse } from "../src/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A server wired exactly as this adapter's serve() wires one. */
async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    await writeWebResponse(res, await app.handle(nodeToWebRequest(req, url)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("@celsian/adapter-node request.ip", () => {
  it("is the address of the connection, not a client-supplied header", async () => {
    const app = createApp();
    app.get("/ip", (req) => ({ ip: req.ip ?? null }));
    const base = await listen(app);

    const res = await fetch(`${base}/ip`, { headers: { "x-forwarded-for": "6.6.6.6" } });

    expect(await res.json()).toEqual({ ip: "127.0.0.1" });
  });
});
