// @celsian/adapter-deno, request.ip comes from Deno.serve's info.remoteAddr

import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { createDenoHandler } from "../src/index.js";

function ipApp() {
  const app = createApp();
  app.get("/ip", (req) => ({ ip: req.ip ?? null }));
  return app;
}

describe("@celsian/adapter-deno request.ip", () => {
  it("is the address Deno reports for the connection", async () => {
    const res = await createDenoHandler(ipApp())(
      new Request("http://localhost/ip", { headers: { "x-forwarded-for": "6.6.6.6" } }),
      { remoteAddr: { transport: "tcp", hostname: "198.51.100.21", port: 40123 } },
    );

    expect(await res.json()).toEqual({ ip: "198.51.100.21" });
  });

  it("is undefined when Deno passes no handler info", async () => {
    const res = await createDenoHandler(ipApp())(new Request("http://localhost/ip"));

    expect(await res.json()).toEqual({ ip: null });
  });
});
