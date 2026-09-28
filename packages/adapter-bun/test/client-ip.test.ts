// @celsian/adapter-bun, request.ip comes from Bun's server.requestIP()

import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { type BunServer, createBunHandler } from "../src/index.js";

function ipApp() {
  const app = createApp();
  app.get("/ip", (req) => ({ ip: req.ip ?? null }));
  return app;
}

describe("@celsian/adapter-bun request.ip", () => {
  it("is the address Bun reports for the connection", async () => {
    const server: BunServer = { upgrade: () => false, requestIP: () => ({ address: "198.51.100.20" }) };

    const res = await createBunHandler(ipApp())(
      new Request("http://localhost/ip", { headers: { "x-forwarded-for": "6.6.6.6" } }),
      server,
    );

    expect(await res?.json()).toEqual({ ip: "198.51.100.20" });
  });

  it("is undefined when the server cannot report one", async () => {
    const res = await createBunHandler(ipApp())(new Request("http://localhost/ip"), { upgrade: () => false });

    expect(await res?.json()).toEqual({ ip: null });
  });
});
