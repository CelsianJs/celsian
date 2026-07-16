import { createApp } from "@celsian/core";
import { describe, expect, it, vi } from "vitest";
import { createJWTGuard, type JWTNamespace, type JWTPayload, jwt } from "../src/index.js";

const SECRET = "test-secret-key-for-testing-only-min-32-chars";

describe("@celsian/jwt", () => {
  it("should sign and verify JWT tokens", async () => {
    const app = createApp();
    await app.register(jwt({ secret: SECRET }), { encapsulate: false });

    const jwtInstance = app.getDecoration("jwt") as JWTNamespace;
    expect(jwtInstance).toBeDefined();

    const token = await jwtInstance.sign({ sub: "user123", role: "admin" });
    expect(typeof token).toBe("string");

    const payload = await jwtInstance.verify(token);
    expect(payload.sub).toBe("user123");
    expect(payload.role).toBe("admin");
    expect(payload.iat).toBeDefined();
  });

  it("should sign tokens with expiration", async () => {
    const app = createApp();
    await app.register(jwt({ secret: SECRET }), { encapsulate: false });

    const jwtInstance = app.getDecoration("jwt") as JWTNamespace;
    const token = await jwtInstance.sign({ sub: "user" }, { expiresIn: "1h" });
    const payload = await jwtInstance.verify(token);
    expect(payload.exp).toBeDefined();
    expect(payload.exp!).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("should reject invalid tokens", async () => {
    const app = createApp();
    await app.register(jwt({ secret: SECRET }), { encapsulate: false });

    const jwtInstance = app.getDecoration("jwt") as JWTNamespace;
    await expect(jwtInstance.verify("invalid.token.here")).rejects.toThrow();
  });

  it("should work without encapsulate: false (default encapsulation)", async () => {
    const app = createApp();
    // Register JWT without { encapsulate: false } — the common user pattern
    await app.register(jwt({ secret: SECRET }));

    // app.jwt should be accessible via getDecoration
    const jwtInstance = app.getDecoration("jwt") as JWTNamespace;
    expect(jwtInstance).toBeDefined();

    // app.jwt should also be directly accessible on the app instance
    expect((app as any).jwt).toBeDefined();

    const token = await jwtInstance.sign({ sub: "user456" });
    const payload = await jwtInstance.verify(token);
    expect(payload.sub).toBe("user456");

    app.get("/protected", {
      preHandler: createJWTGuard(),
      handler: (req, reply) => reply.json({ sub: (req as { user?: JWTPayload }).user?.sub }),
    });
    const protectedResponse = await app.inject({
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(protectedResponse.status).toBe(200);
    expect(await protectedResponse.json()).toEqual({ sub: "user456" });
  });

  it("should reject tokens with wrong secret", async () => {
    const app1 = createApp();
    await app1.register(jwt({ secret: SECRET }), { encapsulate: false });
    const jwt1 = app1.getDecoration("jwt") as JWTNamespace;

    const app2 = createApp();
    await app2.register(jwt({ secret: "different-secret-that-is-long-enough" }), { encapsulate: false });
    const jwt2 = app2.getDecoration("jwt") as JWTNamespace;

    const token = await jwt1.sign({ sub: "user" });
    await expect(jwt2.verify(token)).rejects.toThrow();
  });
});

describe("createJWTGuard", () => {
  it("should protect routes with JWT", async () => {
    const app = createApp();
    await app.register(jwt({ secret: SECRET }), { encapsulate: false });
    const jwtInstance = app.getDecoration("jwt") as JWTNamespace;

    const guard = createJWTGuard({ secret: SECRET });

    app.route({
      method: "GET",
      url: "/protected",
      preHandler: guard,
      handler: (req, reply) => {
        return reply.json({ user: (req as any).user });
      },
    });

    // Without token
    const noAuth = await app.inject({ url: "/protected" });
    expect(noAuth.status).toBe(401);

    // With valid token
    const token = await jwtInstance.sign({ sub: "user123" });
    const withAuth = await app.inject({
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(withAuth.status).toBe(200);
    const body = await withAuth.json();
    expect(body.user.sub).toBe("user123");
  });

  it("should reject expired tokens", async () => {
    const app = createApp();
    await app.register(jwt({ secret: SECRET }), { encapsulate: false });
    const jwtInstance = app.getDecoration("jwt") as JWTNamespace;

    const guard = createJWTGuard({ secret: SECRET });

    app.route({
      method: "GET",
      url: "/protected",
      preHandler: guard,
      handler: (_req, reply) => reply.json({ ok: true }),
    });

    // Sign with already-expired timestamp
    const token = await jwtInstance.sign({ sub: "user" }, { expiresIn: -1 });
    const response = await app.inject({
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });

  it("should reject malformed authorization header", async () => {
    const app = createApp();
    const guard = createJWTGuard({ secret: SECRET });

    app.route({
      method: "GET",
      url: "/protected",
      preHandler: guard,
      handler: (_req, reply) => reply.json({ ok: true }),
    });

    const response = await app.inject({
      url: "/protected",
      headers: { authorization: "Basic user:pass" },
    });
    expect(response.status).toBe(401);
  });
});

describe("createJWTGuard (lazy, no-arg) honors configured algorithms", () => {
  // Regression for: lazy createJWTGuard() hardcoded algorithms:["HS256"], ignoring the
  // algorithm the JWT plugin was registered with. A token signed with HS512 must verify
  // through the no-arg guard, and a token signed with a non-allowed alg must be rejected.
  it("should verify HS512 tokens via the no-arg guard when the plugin is registered with HS512", async () => {
    const app = createApp();
    await app.register(jwt({ secret: SECRET, algorithms: ["HS512"] }), { encapsulate: false });
    const jwtInstance = app.getDecoration("jwt") as JWTNamespace;

    // No-arg guard — must read algorithms from the plugin's per-app config (HS512), not HS256.
    const guard = createJWTGuard();

    app.route({
      method: "GET",
      url: "/protected",
      preHandler: guard,
      handler: (req, reply) => reply.json({ user: (req as { user?: unknown }).user }),
    });

    const token = await jwtInstance.sign({ sub: "hs512-user" });
    const res = await app.inject({
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.sub).toBe("hs512-user");
  });

  it("should reject a token signed with a different alg than the plugin allows", async () => {
    const app = createApp();
    await app.register(jwt({ secret: SECRET, algorithms: ["HS512"] }), { encapsulate: false });

    const guard = createJWTGuard();
    app.route({
      method: "GET",
      url: "/protected",
      preHandler: guard,
      handler: (_req, reply) => reply.json({ ok: true }),
    });

    // Sign with HS256 using the SAME secret — should be rejected because the guard only allows HS512.
    const { SignJWT } = await import("jose");
    const hs256Token = await new SignJWT({ sub: "wrong-alg" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .sign(new TextEncoder().encode(SECRET));

    const res = await app.inject({
      url: "/protected",
      headers: { authorization: `Bearer ${hs256Token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("createJWTGuard (lazy, no-arg) binds to its owning app (no cross-app secret bleed)", () => {
  // Regression for: the lazy guard read the secret from a module-global WeakRef
  // (_lastRegisteredApp), so with multiple apps the guard bound to whichever app registered
  // LAST, leaking secrets across apps. Each guard must bind to the app it was created for.
  it("should not verify app A's token on app B (and each verifies its own)", async () => {
    const SECRET_A = "secret-A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SECRET_B = "secret-B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const appA = createApp();
    await appA.register(jwt({ secret: SECRET_A }), { encapsulate: false });
    const jwtA = appA.getDecoration("jwt") as JWTNamespace;
    const guardA = createJWTGuard();
    appA.route({
      method: "GET",
      url: "/protected",
      preHandler: guardA,
      handler: (req, reply) => reply.json({ user: (req as { user?: unknown }).user }),
    });

    // App B registers AFTER app A — previously this would rebind app A's lazy guard to app B.
    const appB = createApp();
    await appB.register(jwt({ secret: SECRET_B }), { encapsulate: false });
    const jwtB = appB.getDecoration("jwt") as JWTNamespace;
    const guardB = createJWTGuard();
    appB.route({
      method: "GET",
      url: "/protected",
      preHandler: guardB,
      handler: (req, reply) => reply.json({ user: (req as { user?: unknown }).user }),
    });

    const tokenA = await jwtA.sign({ sub: "user-A" });
    const tokenB = await jwtB.sign({ sub: "user-B" });

    // Each app verifies its own token.
    const aSelf = await appA.inject({ url: "/protected", headers: { authorization: `Bearer ${tokenA}` } });
    expect(aSelf.status).toBe(200);
    expect((await aSelf.json()).user.sub).toBe("user-A");

    const bSelf = await appB.inject({ url: "/protected", headers: { authorization: `Bearer ${tokenB}` } });
    expect(bSelf.status).toBe(200);
    expect((await bSelf.json()).user.sub).toBe("user-B");

    // App A must NOT accept a token signed for app B, and vice versa.
    const aRejectsB = await appA.inject({ url: "/protected", headers: { authorization: `Bearer ${tokenB}` } });
    expect(aRejectsB.status).toBe(401);

    const bRejectsA = await appB.inject({ url: "/protected", headers: { authorization: `Bearer ${tokenA}` } });
    expect(bRejectsA.status).toBe(401);
  });

  // Regression for the reviewer-reproduced defeat: with the order "register A, register B,
  // THEN create both guards", a creation-time binding to _lastRegisteredApp bound BOTH guards
  // to app B, so app A accepted app B's token (200 instead of 401). The fix resolves config
  // from the request at request time, so order no longer matters.
  it("should isolate apps even when both guards are created AFTER both plugins are registered", async () => {
    const SECRET_A = "secret-A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SECRET_B = "secret-B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // Register BOTH plugins first...
    const appA = createApp();
    await appA.register(jwt({ secret: SECRET_A }), { encapsulate: false });
    const jwtA = appA.getDecoration("jwt") as JWTNamespace;

    const appB = createApp();
    await appB.register(jwt({ secret: SECRET_B }), { encapsulate: false });
    const jwtB = appB.getDecoration("jwt") as JWTNamespace;

    // ...THEN create both guards (both would bind to the last-registered app B under the old fix).
    const guardA = createJWTGuard();
    const guardB = createJWTGuard();

    appA.route({
      method: "GET",
      url: "/protected",
      preHandler: guardA,
      handler: (req, reply) => reply.json({ user: (req as { user?: unknown }).user }),
    });
    appB.route({
      method: "GET",
      url: "/protected",
      preHandler: guardB,
      handler: (req, reply) => reply.json({ user: (req as { user?: unknown }).user }),
    });

    const tokenA = await jwtA.sign({ sub: "user-A" });
    const tokenB = await jwtB.sign({ sub: "user-B" });

    // Each app verifies its own token.
    expect((await appA.inject({ url: "/protected", headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(200);
    expect((await appB.inject({ url: "/protected", headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(200);

    // The defeat: app A must NOT accept a token signed for app B (was 200, must be 401).
    expect((await appA.inject({ url: "/protected", headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(401);
    expect((await appB.inject({ url: "/protected", headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(401);
  });

  it("does not fall back to another app's config when the current request has no JWT decoration", async () => {
    const configuredApp = createApp();
    await configuredApp.register(jwt({ secret: "configured-app-secret-aaaaaaaaaaaaaaaa" }), { encapsulate: false });
    const configuredJwt = configuredApp.getDecoration("jwt") as JWTNamespace;
    const token = await configuredJwt.sign({ sub: "configured-user" });

    const appWithoutJwt = createApp();
    appWithoutJwt.route({
      method: "GET",
      url: "/protected",
      preHandler: createJWTGuard(),
      handler: (_req, reply) => reply.json({ ok: true }),
    });

    const response = await appWithoutJwt.inject({
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("JWT plugin has not been registered"),
    });
  });

  it("keeps different secrets and algorithms isolated under concurrent requests", async () => {
    const appA = createApp();
    await appA.register(jwt({ secret: "secret-A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", algorithms: ["HS256"] }), {
      encapsulate: false,
    });
    const jwtA = appA.getDecoration("jwt") as JWTNamespace;

    const appB = createApp();
    await appB.register(jwt({ secret: "secret-B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", algorithms: ["HS512"] }), {
      encapsulate: false,
    });
    const jwtB = appB.getDecoration("jwt") as JWTNamespace;

    for (const app of [appA, appB]) {
      app.route({
        method: "GET",
        url: "/protected",
        preHandler: createJWTGuard(),
        handler: (req, reply) => reply.json({ sub: (req as { user?: { sub?: string } }).user?.sub }),
      });
    }

    const tokenA = await jwtA.sign({ sub: "user-A" });
    const tokenB = await jwtB.sign({ sub: "user-B" });
    const responses = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const app = index % 2 === 0 ? appA : appB;
        const ownToken = index % 2 === 0 ? tokenA : tokenB;
        const foreignToken = index % 2 === 0 ? tokenB : tokenA;
        return Promise.all([
          app.inject({ url: "/protected", headers: { authorization: `Bearer ${ownToken}` } }),
          app.inject({ url: "/protected", headers: { authorization: `Bearer ${foreignToken}` } }),
        ]);
      }),
    );

    for (const [own, foreign] of responses) {
      expect(own.status).toBe(200);
      expect(foreign.status).toBe(401);
    }
  });
});

describe("weak HMAC secret warning", () => {
  it("warns via console.warn when an HS* secret is shorter than 32 bytes", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const app = createApp();
      await app.register(jwt({ secret: "short" }), { encapsulate: false });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[@celsian/jwt]");
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("5 bytes");

      // Non-breaking: the plugin still works with the weak secret.
      const jwtInstance = app.getDecoration("jwt") as JWTNamespace;
      const token = await jwtInstance.sign({ sub: "user" });
      expect((await jwtInstance.verify(token)).sub).toBe("user");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns for short secrets passed directly to createJWTGuard()", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createJWTGuard({ secret: "tiny" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for secrets of 32 bytes or more", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const app = createApp();
      await app.register(jwt({ secret: SECRET }), { encapsulate: false });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
