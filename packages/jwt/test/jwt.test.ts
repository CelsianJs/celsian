import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { createJWTGuard, type JWTNamespace, jwt } from "../src/index.js";

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
