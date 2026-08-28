// @celsian/core, the two things that bite on a developer's first `npm run dev`
//
// 1. The dev default host was the NAME "localhost", which Node resolves
//    verbatim since v17. On any machine with IPv6 that binds ::1 ONLY, so
//    `curl http://127.0.0.1:3000/health` is refused while the server is
//    plainly running. The `basic` template sets no HOST, so the simplest
//    template (the one a beginner picks) was the one that broke.
// 2. A taken port arrived as `unhandledRejection, shutting down` plus a
//    Node-internal stack, which reads like the framework crashed rather than
//    like "port 3000 is busy".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { defaultHost } from "../src/config.js";
import { ServeListenError, serve } from "../src/serve.js";

describe("default dev bind host", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("is reachable at 127.0.0.1, the address every tool and doc reaches for", async () => {
    vi.stubEnv("HOST", "");
    const app = createApp();
    app.get("/health", (_req, reply) => reply.json({ status: "ok" }));

    // No `host` option and no HOST env: exactly what the `basic` template does.
    let readyInfo: { port: number; host: string } | undefined;
    const { close } = await serve(app, {
      port: 0,
      onReady: (info) => {
        readyInfo = info;
      },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${readyInfo!.port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    } finally {
      await close();
    }
  });

  it("is an address literal, not a name whose family depends on the resolver", () => {
    vi.stubEnv("HOST", "");
    vi.stubEnv("NODE_ENV", "development");
    // A name is the defect: which family it lands on is the machine's call.
    expect(defaultHost()).toBe("127.0.0.1");
  });

  it("still binds every interface in production, so containers stay reachable", () => {
    vi.stubEnv("HOST", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(defaultHost()).toBe("0.0.0.0");
  });
});

describe("a port that is already in use", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("explains itself in one line instead of surfacing Node's raw listen error", async () => {
    const first = createApp();
    let port = 0;
    const { close } = await serve(first, {
      port: 0,
      host: "127.0.0.1",
      onReady: (info) => {
        port = info.port;
      },
    });

    try {
      const second = createApp();
      const err = await serve(second, { port, host: "127.0.0.1" }).then(
        () => new Error("serve() resolved, but the port was taken"),
        (e: unknown) => e,
      );
      await second.stopWorker();
      second.stopCron();

      expect(err).toBeInstanceOf(ServeListenError);
      const message = (err as Error).message;
      // One line, in the developer's own vocabulary.
      expect(message.split("\n")).toHaveLength(1);
      expect(message).toContain(`Port ${port} is already in use`);
      // Says how to move on, not just what failed.
      expect(message).toContain("PORT=");
      // Node's wording is kept for debugging, but is not what the user reads.
      expect(message).not.toContain("EADDRINUSE");
      expect(((err as ServeListenError).cause as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
    } finally {
      await close();
    }
  });

  it("prints as one clean line, not as an unhandled rejection with a stack", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const app = createApp();
    const { close } = await serve(app, { port: 0, host: "127.0.0.1" });

    // The template calls `serve(app)` without awaiting it, so a listen failure
    // reaches the process as an unhandled rejection. Drive that same handler.
    const listeners = process.listeners("unhandledRejection");
    const handler = listeners[listeners.length - 1] as (reason: unknown) => void;

    try {
      handler(new ServeListenError("Port 3000 is already in use.", new Error("raw")));
      await new Promise((r) => setTimeout(r, 50));

      const printed = errorSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(printed).toContain("Port 3000 is already in use.");
      // No crash framing, and no Error object dumped with its stack.
      expect(printed).not.toContain("unhandledRejection");
      expect(printed).not.toContain("at ");
      // Still a failure: non-zero exit.
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      await close();
    }
  });
});
