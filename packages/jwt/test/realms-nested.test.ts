// @celsian/jwt -- cross-tenant isolation for nested and un-prefixed realm registrations
//
// Companion to realms.test.ts. That file covers two realms registered directly
// on one app. This file covers the two shapes that the 0.6.0 sprint flagged as
// unproven, both of which route the JWT config through a CHILD context rather
// than an ancestor of the matched route:
//
//   1. app.register(tenantPlugin, { prefix }) where tenantPlugin internally
//      registers jwt() with no { encapsulate: false }.
//   2. Two un-prefixed realms on one app, which is the worst case for the
//      app-scope fallback because neither registration is scoped by a prefix.
//
// Both previously risked last-writer-wins at the root context (CRIT-3), where a
// second jwt() overwrote the first and every route in the app authenticated
// against the last-registered realm.
import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { createJWTGuard, jwt } from "../src/index.js";

const SECRET_A = "tenant-A-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_B = "tenant-B-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("JWT realm isolation, nested and un-prefixed", () => {
  it("isolates realms when jwt() is registered inside a prefixed plugin", async () => {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    // Deliberately the plain nested form: no { encapsulate: false }.
    await app.register(
      async (tenant) => {
        await tenant.register(realmA);
        tenant.addHook("preHandler", createJWTGuard());
        tenant.get("/me", (_r, reply) => reply.json({ realm: "A" }));
      },
      { prefix: "/tenant-a" },
    );
    await app.register(
      async (tenant) => {
        await tenant.register(realmB);
        tenant.addHook("preHandler", createJWTGuard());
        tenant.get("/me", (_r, reply) => reply.json({ realm: "B" }));
      },
      { prefix: "/tenant-b" },
    );

    const tokenB = await realmB.sign({ sub: "user-b" });
    const tokenA = await realmA.sign({ sub: "user-a" });

    // Tenant B's token must not authenticate against tenant A's routes.
    const cross = await app.inject({
      url: "/tenant-a/me",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(cross.status).toBe(401);

    // And tenant A's own users must still get through: a fix that locks
    // everyone out is not a fix.
    const legit = await app.inject({
      url: "/tenant-a/me",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(legit.status).toBe(200);
    expect(await legit.json()).toEqual({ realm: "A" });
  });

  it("isolates two un-prefixed realms on one app", async () => {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    await app.register(async (t) => {
      await t.register(realmA, { encapsulate: false });
      t.addHook("preHandler", createJWTGuard());
      t.get("/a/me", (_r, reply) => reply.json({ realm: "A" }));
    });
    await app.register(async (t) => {
      await t.register(realmB, { encapsulate: false });
      t.addHook("preHandler", createJWTGuard());
      t.get("/b/me", (_r, reply) => reply.json({ realm: "B" }));
    });

    const tokenA = await realmA.sign({ sub: "user-a" });
    const tokenB = await realmB.sign({ sub: "user-b" });

    expect((await app.inject({ url: "/a/me", headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(401);
    expect((await app.inject({ url: "/b/me", headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(401);

    // Each realm still accepts its own token.
    expect((await app.inject({ url: "/a/me", headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(200);
    expect((await app.inject({ url: "/b/me", headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(200);
  });

  it("decorates app.jwt even when jwt() is registered under a prefix", async () => {
    const app = createApp();
    await app.register(jwt({ secret: SECRET_A }), { prefix: "/x" });
    expect(typeof (app as unknown as Record<string, unknown>).jwt).toBe("object");
  });
});
