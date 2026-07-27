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

  /**
   * Two un-prefixed realms cannot be isolated by an unbound guard, so the
   * unbound guard now refuses instead of pretending.
   *
   * A plugin registered without a prefix is APP-WIDE by core's own definition
   * (see `collectScopeContexts` in packages/core/src/context.ts: an un-prefixed
   * child is "transparent", and its hooks and decorations apply to the whole
   * surrounding scope, siblings included). So here both realms cover /a/me AND
   * /b/me, and both `createJWTGuard()` hooks run on both routes.
   *
   * This shape used to produce the right answer only because core's decoration
   * merge is last-writer-wins over a chain that happens to end at the route's
   * own context. That tie-break is not isolation: register the realms directly
   * on the app instead of inside a wrapper closure and the exact same code
   * authenticated tenant B on tenant A's route (see realm-ambiguity.test.ts).
   * Relying on it would have left that bypass in place, so the guard now fails
   * CLOSED whenever more than one realm covers the matched route, and names the
   * two ways to say which realm you mean.
   */
  it("refuses to guess between two un-prefixed realms rather than relying on a tie-break", async () => {
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

    const messages: string[] = [];
    app.setErrorHandler((error) => {
      messages.push(error.message);
      return new Response("handled", { status: 500 });
    });

    const tokenA = await realmA.sign({ sub: "user-a" });
    const tokenB = await realmB.sign({ sub: "user-b" });

    // Neither the cross-tenant token nor the realm's own token authenticates:
    // no route here belongs to exactly one realm.
    for (const url of ["/a/me", "/b/me"]) {
      for (const token of [tokenA, tokenB]) {
        expect((await app.inject({ url, headers: { authorization: `Bearer ${token}` } })).status).not.toBe(200);
      }
    }

    expect(messages[0]).toMatch(/2 JWT realms/);
    expect(messages[0]).toMatch(/prefix: '\/tenant-a'/);
  });

  /**
   * The remedy for the shape above. `addHook` on an un-prefixed context is
   * app-wide, so BOTH scope hooks run on BOTH routes there, which is why no
   * guard placed that way can isolate anything. A realm-bound guard attached to
   * the route itself runs only for that route.
   */
  it("isolates two un-prefixed realms once each route carries its own realm-bound guard", async () => {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    await app.register(async (t) => {
      await t.register(realmA, { encapsulate: false });
      t.get("/a/me", { preHandler: realmA.guard() }, (_r, reply) => reply.json({ realm: "A" }));
    });
    await app.register(async (t) => {
      await t.register(realmB, { encapsulate: false });
      t.get("/b/me", { preHandler: realmB.guard() }, (_r, reply) => reply.json({ realm: "B" }));
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
