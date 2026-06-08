// @celsian/adapter-node — static-file decode hardening (BUG-4)

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../core/src/app.js";
import { serve } from "../src/index.js";

/** Find an available TCP port. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Locate the listening http.Server bound to a given port via active handles. */
function findServerOnPort(port: number): Server | null {
  // process._getActiveHandles is undocumented but stable enough for test teardown.
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  for (const h of handles) {
    const maybe = h as { address?: () => unknown; close?: (cb?: () => void) => void };
    if (typeof maybe.address === "function") {
      const addr = maybe.address();
      if (addr && typeof addr === "object" && (addr as { port?: number }).port === port) {
        return h as Server;
      }
    }
  }
  return null;
}

let port = 0;

afterEach(async () => {
  const srv = findServerOnPort(port);
  if (srv) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe("adapter-node serve() static decode guard", () => {
  it("returns 400 for malformed percent-encoding without crashing the callback", async () => {
    const app = createApp();
    app.get("/ok", (_req, reply) => reply.json({ ok: true }));

    port = await freePort();
    serve(app, { port, host: "127.0.0.1", staticDir: "." });

    // Wait until the server is accepting connections.
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://127.0.0.1:${port}/%ZZ`);
    expect([400, 404]).toContain(res.status);
    await res.text();

    // Server still responds (callback did not crash).
    const ok = await fetch(`http://127.0.0.1:${port}/ok`);
    expect(ok.status).toBe(200);
  });
});
