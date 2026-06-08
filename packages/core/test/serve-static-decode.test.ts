// @celsian/core — serve() static-file decode hardening (BUG-4) and structured-logger routing (BUG-11)

import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { handleError } from "../src/error-handler.js";
import type { Logger } from "../src/logger.js";
import { createReply } from "../src/reply.js";
import { buildRequest } from "../src/request.js";
import { serve } from "../src/serve.js";

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

describe("[4] serve() static decode guard", () => {
  it("returns 400 for malformed percent-encoding instead of crashing", async () => {
    const app = createApp();
    app.get("/ok", (_req, reply) => reply.json({ ok: true }));

    const port = await freePort();
    const { close } = await serve(app, { port, host: "127.0.0.1", staticDir: "." });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/%ZZ`);
      // Must be a clean error, not a dropped/crashed connection.
      expect([400, 404]).toContain(res.status);
      await res.text();

      // Server is still alive afterwards.
      const ok = await fetch(`http://127.0.0.1:${port}/ok`);
      expect(ok.status).toBe(200);
    } finally {
      await close();
    }
  });
});

describe("[11] error handler routes through structured logger", () => {
  function makeRequest(): ReturnType<typeof buildRequest> {
    return buildRequest(new Request("http://localhost/x"), new URL("http://localhost/x"), {});
  }

  it("uses the provided logger (not console) when an onError hook throws", async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const throwingHook = () => {
      throw new Error("hook boom");
    };

    const res = await handleError(new Error("orig"), makeRequest(), createReply(), null, [throwingHook], logger);

    expect(res.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith("onError hook failed", expect.objectContaining({ error: "hook boom" }));
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("falls back to console when no logger is provided", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwingHook = () => {
      throw new Error("hook boom2");
    };

    await handleError(new Error("orig"), makeRequest(), createReply(), null, [throwingHook]);

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
