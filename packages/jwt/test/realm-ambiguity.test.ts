// @celsian/jwt -- cross-tenant bypasses when several realms share one app
//
// Two confirmed bypasses are pinned here.
//
// C1: a realm registered WITHOUT a prefix creates a transparent encapsulation
//     context, so its request decorations propagate into the parent scope. Two
//     of them and every route in the parent scope resolved whichever realm
//     registered LAST: tenant B authenticated on tenant A's route while tenant
//     A's own users were locked out. The realm census that was supposed to
//     catch this only ran when NO scoped realm was found, which never happened
//     in this shape.
//
// C2: core hoists app decorations first-writer-wins, so `app.jwt` bound to
//     realm #1 for the whole app. Tenant B's login route, using the documented
//     `app.jwt.sign()` API, minted credentials signed with TENANT A's secret.
//
// Both must fail CLOSED and loudly. The escape hatches (a realm-bound
// `jwt(...).guard()`, an explicit `createJWTGuard({ secret })`, and the
// realm-bound `realm.sign()`) must keep working, and single-realm apps must be
// completely unaffected.

import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { createJWTGuard, jwt } from "../src/index.js";

const SECRET_A = "tenant-A-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_B = "tenant-B-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** Read `request.user.sub` without widening the handler's request type. */
function subjectOf(request: unknown): string | undefined {
  return (request as { user?: { sub?: string } }).user?.sub;
}

describe("C1: two un-prefixed realms registered directly on the app", () => {
  /**
   * Exactly the form shown in the `jwt()` JSDoc: register the plugin on the app
   * with no wrapper closure and no prefix. Both realm contexts are transparent
   * children of the root, so both apply to a root route and neither is nearer.
   */
  async function buildUnprefixedApp() {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    await app.register(realmA);
    await app.register(realmB);

    app.get("/a", { preHandler: createJWTGuard() }, (req, reply) => reply.json({ route: "A", sub: subjectOf(req) }));
    await app.ready();

    return { app, realmA, realmB };
  }

  it("refuses to authenticate tenant B's token on tenant A's route", async () => {
    const { app, realmB } = await buildUnprefixedApp();

    // The proven bypass: 200 {"route":"A","sub":"mallory","iss":"tenant-b"}.
    const crossTenant = await app.inject({
      url: "/a",
      headers: { authorization: `Bearer ${await realmB.sign({ sub: "mallory", iss: "tenant-b" })}` },
    });
    expect(crossTenant.status).not.toBe(200);
  });

  it("refuses to guess even for the realm that registered first", async () => {
    const { app, realmA } = await buildUnprefixedApp();

    // Failing closed means closed for everyone: picking realm A here would be
    // the same guess, just with the other tie-break.
    const own = await app.inject({
      url: "/a",
      headers: { authorization: `Bearer ${await realmA.sign({ sub: "alice" })}` },
    });
    expect(own.status).not.toBe(200);
  });

  it("names the actionable fix when the route sits inside two realms at once", async () => {
    const { app, realmB } = await buildUnprefixedApp();

    const messages: string[] = [];
    app.setErrorHandler((error) => {
      messages.push(error.message);
      return new Response("handled", { status: 500 });
    });

    await app.inject({ url: "/a", headers: { authorization: `Bearer ${await realmB.sign({ sub: "mallory" })}` } });

    expect(messages[0]).toMatch(/2 JWT realms/);
    expect(messages[0]).toMatch(/jwt\(\.\.\.\)\.guard\(\)/);
    expect(messages[0]).toMatch(/createJWTGuard\(\{ secret \}\)/);
    expect(messages[0]).toMatch(/prefix/);
  });

  it("keeps working when each guard is bound to its realm", async () => {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    await app.register(realmA);
    await app.register(realmB);

    app.get("/a", { preHandler: realmA.guard() }, (req, reply) => reply.json({ route: "A", sub: subjectOf(req) }));
    app.get("/b", { preHandler: realmB.guard() }, (req, reply) => reply.json({ route: "B", sub: subjectOf(req) }));
    await app.ready();

    const tokenA = await realmA.sign({ sub: "alice" });
    const tokenB = await realmB.sign({ sub: "mallory" });

    expect((await app.inject({ url: "/a", headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(401);
    expect((await app.inject({ url: "/b", headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(401);

    const aSelf = await app.inject({ url: "/a", headers: { authorization: `Bearer ${tokenA}` } });
    expect(aSelf.status).toBe(200);
    expect(await aSelf.json()).toEqual({ route: "A", sub: "alice" });

    const bSelf = await app.inject({ url: "/b", headers: { authorization: `Bearer ${tokenB}` } });
    expect(bSelf.status).toBe(200);
    expect(await bSelf.json()).toEqual({ route: "B", sub: "mallory" });
  });
});

describe("C2: app.jwt with more than one realm", () => {
  it("refuses to sign rather than minting tenant B's token with tenant A's secret", async () => {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    await app.register(realmA, { prefix: "/tenant-a" });
    await app.register(realmB, { prefix: "/tenant-b" });
    await app.ready();

    await expect(app.jwt.sign({ sub: "mallory", iss: "tenant-b" })).rejects.toThrow(/2 JWT realms/);
    await expect(app.jwt.verify("not-a-token")).rejects.toThrow(/2 JWT realms/);
  });

  it("names the realm-bound alternative in the error", async () => {
    const app = createApp();
    await app.register(jwt({ secret: SECRET_A }), { prefix: "/tenant-a" });
    await app.register(jwt({ secret: SECRET_B }), { prefix: "/tenant-b" });
    await app.ready();

    await expect(app.jwt.sign({ sub: "x" })).rejects.toThrow(/realm\.sign\(\)/);
  });

  it("leaves the realm-bound sign path working, and it signs with the right secret", async () => {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    await app.register(realmA, { prefix: "/tenant-a" });
    await app.register(realmB, { prefix: "/tenant-b" });
    await app.ready();

    const tokenB = await realmB.sign({ sub: "bob", iss: "tenant-b" });
    expect((await realmB.verify(tokenB)).sub).toBe("bob");
    await expect(realmA.verify(tokenB)).rejects.toThrow();
  });

  it("keeps app.jwt working exactly as before for a single realm", async () => {
    const realm = jwt({ secret: SECRET_A });
    const app = createApp();
    await app.register(realm);
    await app.ready();

    const token = await app.jwt.sign({ sub: "solo" });
    expect((await app.jwt.verify(token)).sub).toBe("solo");
    // Same key material as the realm handle, not a second independent realm.
    expect((await realm.verify(token)).sub).toBe("solo");
  });
});

describe("realm shapes that must keep working", () => {
  it("two prefixed realms, each route resolves its own realm", async () => {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    const mount = (realm: ReturnType<typeof jwt>, name: string, prefix: string) =>
      app.register(
        async (tenant) => {
          await tenant.register(realm, { encapsulate: false });
          tenant.addHook("preHandler", createJWTGuard());
          tenant.get("/me", (req, reply) => reply.json({ realm: name, sub: subjectOf(req) }));
        },
        { prefix },
      );

    await mount(realmA, "A", "/tenant-a");
    await mount(realmB, "B", "/tenant-b");
    await app.ready();

    const tokenA = await realmA.sign({ sub: "alice" });
    const tokenB = await realmB.sign({ sub: "bob" });

    const aSelf = await app.inject({ url: "/tenant-a/me", headers: { authorization: `Bearer ${tokenA}` } });
    expect(aSelf.status).toBe(200);
    expect(await aSelf.json()).toEqual({ realm: "A", sub: "alice" });

    const bSelf = await app.inject({ url: "/tenant-b/me", headers: { authorization: `Bearer ${tokenB}` } });
    expect(bSelf.status).toBe(200);
    expect(await bSelf.json()).toEqual({ realm: "B", sub: "bob" });

    expect((await app.inject({ url: "/tenant-a/me", headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(
      401,
    );
    expect((await app.inject({ url: "/tenant-b/me", headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(
      401,
    );
  });

  it("nested registration inside a prefixed plugin, each route resolves its own realm", async () => {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    // The plain nested form: jwt() gets its own child context under the prefix.
    const mount = (realm: ReturnType<typeof jwt>, name: string, prefix: string) =>
      app.register(
        async (tenant) => {
          await tenant.register(realm);
          tenant.addHook("preHandler", createJWTGuard());
          tenant.get("/me", (req, reply) => reply.json({ realm: name, sub: subjectOf(req) }));
        },
        { prefix },
      );

    await mount(realmA, "A", "/tenant-a");
    await mount(realmB, "B", "/tenant-b");
    await app.ready();

    const tokenA = await realmA.sign({ sub: "alice" });
    const tokenB = await realmB.sign({ sub: "bob" });

    const aSelf = await app.inject({ url: "/tenant-a/me", headers: { authorization: `Bearer ${tokenA}` } });
    expect(aSelf.status).toBe(200);
    expect(await aSelf.json()).toEqual({ realm: "A", sub: "alice" });

    expect((await app.inject({ url: "/tenant-a/me", headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(
      401,
    );
    expect((await app.inject({ url: "/tenant-b/me", headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(
      401,
    );
  });

  it("a single un-prefixed realm still resolves anywhere on the app", async () => {
    const realm = jwt({ secret: SECRET_A });
    const app = createApp();

    await app.register(realm);
    app.get("/anywhere", { preHandler: createJWTGuard() }, (req, reply) => reply.json({ sub: subjectOf(req) }));
    await app.ready();

    const ok = await app.inject({
      url: "/anywhere",
      headers: { authorization: `Bearer ${await realm.sign({ sub: "solo" })}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sub: "solo" });
  });

  it("a single prefixed realm still resolves on a route outside its prefix", async () => {
    const realm = jwt({ secret: SECRET_A });
    const app = createApp();

    await app.register(realm, { prefix: "/api" });
    app.get("/root", { preHandler: createJWTGuard() }, (req, reply) => reply.json({ sub: subjectOf(req) }));
    await app.ready();

    const ok = await app.inject({
      url: "/root",
      headers: { authorization: `Bearer ${await realm.sign({ sub: "solo" })}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sub: "solo" });
  });
});
