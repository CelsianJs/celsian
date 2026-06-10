// @celsian/core -- serve() tests: listen race, real bound port, WS + loopback warnings (CORE-01/07/08)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { serve } from "../src/serve.js";

describe("serve (Node)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolves only after listening: the server is immediately reachable (port 0 -> real port)", async () => {
    const app = createApp();
    app.get("/ping", (_req, reply) => reply.json({ pong: true }));

    let readyInfo: { port: number; host: string } | undefined;
    const { close } = await serve(app, {
      port: 0,
      host: "127.0.0.1",
      onReady: (info) => {
        readyInfo = info;
      },
    });

    try {
      // onReady must have fired by the time serve() resolves, with the REAL port
      expect(readyInfo).toBeDefined();
      expect(readyInfo!.port).toBeGreaterThan(0);
      expect(readyInfo!.host).toBe("127.0.0.1");

      // No ECONNREFUSED race: connect immediately after serve() resolves
      const res = await fetch(`http://127.0.0.1:${readyInfo!.port}/ping`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pong: true });
    } finally {
      await close();
    }
  });

  it("logs the actually bound address (resolved from server.address())", async () => {
    const app = createApp();
    app.get("/x", (_req, reply) => reply.json({ ok: true }));

    const { close } = await serve(app, { port: 0, host: "127.0.0.1" });
    try {
      const logged = logSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("Server running"));
      expect(logged.length).toBeGreaterThan(0);
      // The real bound address and a real (non-zero) port, not the requested ":0"
      expect(logged[0]).toContain("http://127.0.0.1:");
      expect(logged[0]).not.toContain(":0");
    } finally {
      await close();
    }
  });

  it("rejects when the port is already in use (listen error propagates)", async () => {
    const app1 = createApp();
    app1.get("/a", (_req, reply) => reply.json({ ok: true }));
    let port = 0;
    const { close } = await serve(app1, {
      port: 0,
      host: "127.0.0.1",
      onReady: (info) => {
        port = info.port;
      },
    });

    try {
      const app2 = createApp();
      app2.get("/b", (_req, reply) => reply.json({ ok: true }));
      await expect(serve(app2, { port, host: "127.0.0.1" })).rejects.toThrow();
      await app2.stopWorker();
      app2.stopCron();
    } finally {
      await close();
    }
  });

  it("warns when WS handlers are registered but the 'ws' package is not installed (CORE-07)", async () => {
    const app = createApp();
    app.ws("/chat", { message: () => {} });
    app.get("/x", (_req, reply) => reply.json({ ok: true }));

    const { close } = await serve(app, { port: 0, host: "127.0.0.1" });
    try {
      const wsWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("'ws' package is not installed"));
      expect(wsWarnings.length).toBe(1);
      expect(wsWarnings[0]).toContain("install");
    } finally {
      await close();
    }
  });

  it("warns that WebSocket routes are not supported on Bun (CORE-07)", async () => {
    vi.stubGlobal("Bun", { serve: () => ({ stop: () => {} }) });

    const app = createApp();
    app.ws("/chat", { message: () => {} });

    const { close } = await serve(app, { port: 0, host: "127.0.0.1" });
    try {
      const bunWarnings = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("not supported on Bun"));
      expect(bunWarnings.length).toBe(1);
    } finally {
      await close();
    }
  });

  it("notes when production binds loopback explicitly (CORE-01)", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const app = createApp();
    app.get("/x", (_req, reply) => reply.json({ ok: true }));

    const { close } = await serve(app, { port: 0, host: "127.0.0.1" });
    try {
      const loopbackNotes = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("loopback"));
      expect(loopbackNotes.length).toBeGreaterThan(0);
      expect(loopbackNotes[0]).toContain("HOST=0.0.0.0");
    } finally {
      await close();
    }
  });

  it("does not warn about loopback for non-loopback binds in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const app = createApp();
    app.get("/x", (_req, reply) => reply.json({ ok: true }));

    const { close } = await serve(app, { port: 0, host: "0.0.0.0" });
    try {
      const loopbackNotes = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("loopback"));
      expect(loopbackNotes.length).toBe(0);
    } finally {
      await close();
    }
  });

  it("honors the HOST env var for the bind host (CORE-01)", async () => {
    vi.stubEnv("HOST", "127.0.0.1");

    const app = createApp();
    app.get("/x", (_req, reply) => reply.json({ ok: true }));

    let readyInfo: { port: number; host: string } | undefined;
    const { close } = await serve(app, {
      port: 0,
      onReady: (info) => {
        readyInfo = info;
      },
    });
    try {
      expect(readyInfo!.host).toBe("127.0.0.1");
      const res = await fetch(`http://127.0.0.1:${readyInfo!.port}/x`);
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });
});
