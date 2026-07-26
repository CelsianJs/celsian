// @celsian/core, WebSocket upgrade authorization (CSWSH defence)
//
// Regression suite for H-5: upgrades used to bypass every hook and had no Origin
// check at all, so evil.com could open an authenticated socket with the victim's
// cookies (classic cross-site WebSocket hijacking).

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { authorizeWSUpgrade, checkWSOrigin, WSConnectionLimiter } from "../src/websocket.js";

function handshake(init: { origin?: string | null; host?: string; url?: string } = {}): Request {
  const headers = new Headers({
    host: init.host ?? "victim.app",
    upgrade: "websocket",
    connection: "Upgrade",
  });
  if (init.origin !== null && init.origin !== undefined) headers.set("origin", init.origin);
  return new Request(init.url ?? "http://victim.app/chat", { method: "GET", headers });
}

describe("checkWSOrigin, default same-origin policy", () => {
  it("rejects a cross-origin handshake", async () => {
    const decision = await checkWSOrigin(handshake({ origin: "https://evil.com" }));
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(403);
    expect(decision.reason).toMatch(/evil\.com/);
  });

  it("accepts a same-origin handshake", async () => {
    const decision = await checkWSOrigin(handshake({ origin: "https://victim.app", host: "victim.app" }));
    expect(decision.allowed).toBe(true);
  });

  it("matches host:port exactly", async () => {
    expect((await checkWSOrigin(handshake({ origin: "http://localhost:3000", host: "localhost:3000" }))).allowed).toBe(
      true,
    );
    // Same host, different port is a different origin.
    expect((await checkWSOrigin(handshake({ origin: "http://localhost:4000", host: "localhost:3000" }))).allowed).toBe(
      false,
    );
  });

  it("rejects a handshake with no Origin header by default", async () => {
    const decision = await checkWSOrigin(handshake({ origin: null }));
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(403);
    expect(decision.reason).toMatch(/allowMissingOrigin/);
  });

  it("accepts a missing Origin only when explicitly opted in", async () => {
    const decision = await checkWSOrigin(handshake({ origin: null }), { allowMissingOrigin: true });
    expect(decision.allowed).toBe(true);
  });

  it("rejects a malformed Origin header", async () => {
    const decision = await checkWSOrigin(handshake({ origin: "not-a-url" }));
    expect(decision.allowed).toBe(false);
  });
});

describe("checkWSOrigin, configured allow-lists", () => {
  it("accepts an allow-listed cross-origin handshake", async () => {
    const decision = await checkWSOrigin(handshake({ origin: "https://app.example.com" }), {
      allowedOrigins: ["https://app.example.com", "https://admin.example.com"],
    });
    expect(decision.allowed).toBe(true);
  });

  it("rejects an origin outside the allow-list", async () => {
    const decision = await checkWSOrigin(handshake({ origin: "https://evil.com" }), {
      allowedOrigins: ["https://app.example.com"],
    });
    expect(decision.allowed).toBe(false);
  });

  it("accepts a single string allow-list entry", async () => {
    const decision = await checkWSOrigin(handshake({ origin: "https://app.example.com" }), {
      allowedOrigins: "https://app.example.com",
    });
    expect(decision.allowed).toBe(true);
  });

  it("normalizes case and a trailing slash", async () => {
    const decision = await checkWSOrigin(handshake({ origin: "https://APP.example.com/" }), {
      allowedOrigins: "https://app.example.com",
    });
    expect(decision.allowed).toBe(true);
  });

  it("treats '*' as any origin (still requires an Origin header)", async () => {
    expect((await checkWSOrigin(handshake({ origin: "https://evil.com" }), { allowedOrigins: "*" })).allowed).toBe(
      true,
    );
    expect((await checkWSOrigin(handshake({ origin: null }), { allowedOrigins: "*" })).allowed).toBe(false);
  });

  it("delegates to a predicate", async () => {
    const opts = { allowedOrigins: (origin: string) => origin.endsWith(".example.com") };
    expect((await checkWSOrigin(handshake({ origin: "https://a.example.com" }), opts)).allowed).toBe(true);
    expect((await checkWSOrigin(handshake({ origin: "https://evil.com" }), opts)).allowed).toBe(false);
  });
});

describe("authorizeWSUpgrade, hooks run on the handshake", () => {
  it("runs root onRequest hooks and lets a guard reject the upgrade", async () => {
    const app = createApp();
    const seen: string[] = [];
    app.addHook("onRequest", (req) => {
      seen.push(new URL(req.url).pathname);
      if (!req.headers.get("authorization")) {
        return new Response("Unauthorized", { status: 401 });
      }
    });
    app.ws("/chat", {});
    await app.ready();

    const decision = await authorizeWSUpgrade(app, handshake({ origin: "https://victim.app" }), "/chat");
    expect(seen).toEqual(["/chat"]);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(401);
  });

  it("allows the upgrade when the guard passes", async () => {
    const app = createApp();
    app.addHook("onRequest", (req) => {
      if (!req.headers.get("authorization")) return new Response("Unauthorized", { status: 401 });
    });
    app.ws("/chat", {});
    await app.ready();

    const req = handshake({ origin: "https://victim.app" });
    req.headers.set("authorization", "Bearer token");
    const decision = await authorizeWSUpgrade(app, req, "/chat");
    expect(decision.allowed).toBe(true);
  });

  it("does not run hooks when the Origin check already failed", async () => {
    const app = createApp();
    let ran = 0;
    app.addHook("onRequest", () => {
      ran++;
    });
    app.ws("/chat", {});
    await app.ready();

    const decision = await authorizeWSUpgrade(app, handshake({ origin: "https://evil.com" }), "/chat");
    expect(decision.allowed).toBe(false);
    expect(ran).toBe(0);
  });

  it("skips hooks when runRequestHooks is false", async () => {
    const app = createApp();
    let ran = 0;
    app.addHook("onRequest", () => {
      ran++;
      return new Response("no", { status: 401 });
    });
    app.ws("/chat", {});
    await app.ready();

    const decision = await authorizeWSUpgrade(app, handshake({ origin: "https://victim.app" }), "/chat", {
      runRequestHooks: false,
    });
    expect(decision.allowed).toBe(true);
    expect(ran).toBe(0);
  });

  it("surfaces a hook that throws as a 500 rather than letting the upgrade through", async () => {
    const app = createApp();
    app.addHook("onRequest", () => {
      throw new Error("boom");
    });
    app.ws("/chat", {});
    await app.ready();

    const decision = await authorizeWSUpgrade(app, handshake({ origin: "https://victim.app" }), "/chat");
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(500);
  });

  it("still honours the onUpgrade callback, after the Origin check", async () => {
    const app = createApp();
    app.ws("/chat", {});
    await app.ready();

    const rejected = await authorizeWSUpgrade(app, handshake({ origin: "https://victim.app" }), "/chat", {
      onUpgrade: () => false,
    });
    expect(rejected.allowed).toBe(false);

    const threw = await authorizeWSUpgrade(app, handshake({ origin: "https://victim.app" }), "/chat", {
      onUpgrade: () => {
        throw new Error("nope");
      },
    });
    expect(threw.allowed).toBe(false);
    expect(threw.status).toBe(403);
  });

  it("tolerates an app object that exposes no hooks", async () => {
    const decision = await authorizeWSUpgrade({}, handshake({ origin: "https://victim.app" }), "/chat");
    expect(decision.allowed).toBe(true);
  });
});

describe("WSConnectionLimiter", () => {
  it("caps concurrent connections per key", () => {
    const limiter = new WSConnectionLimiter(2);
    expect(limiter.acquire("1.2.3.4")).toBe(true);
    expect(limiter.acquire("1.2.3.4")).toBe(true);
    expect(limiter.acquire("1.2.3.4")).toBe(false);
    expect(limiter.count("1.2.3.4")).toBe(2);
  });

  it("counts keys independently and frees slots on release", () => {
    const limiter = new WSConnectionLimiter(1);
    expect(limiter.acquire("a")).toBe(true);
    expect(limiter.acquire("b")).toBe(true);
    expect(limiter.acquire("a")).toBe(false);
    limiter.release("a");
    expect(limiter.count("a")).toBe(0);
    expect(limiter.acquire("a")).toBe(true);
  });

  it("treats max <= 0 as unlimited", () => {
    const limiter = new WSConnectionLimiter(0);
    for (let i = 0; i < 100; i++) expect(limiter.acquire("a")).toBe(true);
  });
});
