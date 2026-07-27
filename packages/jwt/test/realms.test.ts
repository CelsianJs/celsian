// @celsian/jwt, two auth realms on ONE app must not cross-authenticate (CRIT-3)

import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { createJWTGuard, jwt } from "../src/index.js";

const SECRET_A = "tenant-A-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_B = "tenant-B-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbb";

/**
 * Register two tenant realms under two prefixes on a SINGLE CelsianApp.
 *
 * The pre-existing suite only ever covered two separate `CelsianApp` INSTANCES,
 * which is exactly why the cross-realm bypass survived: with `scope: "app"` the
 * config of every realm was hoisted onto the one root context map, so the
 * last-registered realm's secret was applied to every request in the process.
 */
async function buildTwoRealmApp(guardFor: (realm: ReturnType<typeof jwt>) => ReturnType<typeof createJWTGuard>) {
  const realmA = jwt({ secret: SECRET_A });
  const realmB = jwt({ secret: SECRET_B });
  const app = createApp();

  await app.register(
    async (tenant) => {
      await tenant.register(realmA, { encapsulate: false });
      tenant.addHook("preHandler", guardFor(realmA));
      tenant.get("/me", (req, reply) =>
        reply.json({ realm: "A", sub: (req as { user?: { sub?: string } }).user?.sub }),
      );
    },
    { prefix: "/tenant-a" },
  );

  await app.register(
    async (tenant) => {
      await tenant.register(realmB, { encapsulate: false });
      tenant.addHook("preHandler", guardFor(realmB));
      tenant.get("/me", (req, reply) =>
        reply.json({ realm: "B", sub: (req as { user?: { sub?: string } }).user?.sub }),
      );
    },
    { prefix: "/tenant-b" },
  );

  return { app, realmA, realmB };
}

describe("two JWT realms on one app", () => {
  /**
   * DEPENDS ON THE CORE HALF OF THIS FIX.
   *
   * `@celsian/jwt` now binds its config to the encapsulation context that
   * registered it (no `scope: "app"` hoist). For a no-argument
   * `createJWTGuard()` to see it, `packages/core` must resolve plugin-scoped
   * request decorations through the MATCHED ROUTE's context chain instead of
   * reading only `rootContext.requestDecorations` (app.ts). Until that lands,
   * the no-arg guard falls back to the app-wide single-realm compatibility
   * decoration and tenant A still accepts tenant B's token.
   *
   * This test is deliberately NOT weakened to pass in the meantime.
   */
  it("rejects tenant B's token on tenant A's routes and still accepts tenant A's own", async () => {
    const { app, realmA, realmB } = await buildTwoRealmApp(() => createJWTGuard());

    const tokenA = await realmA.sign({ sub: "user-a" });
    const tokenB = await realmB.sign({ sub: "user-b" });

    // The proven bypass: B's token authenticated against A's routes.
    const crossTenant = await app.inject({
      url: "/tenant-a/me",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(crossTenant.status).toBe(401);

    // And the flip side of the same bug: legitimate users locked out.
    const legitimate = await app.inject({
      url: "/tenant-a/me",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(legitimate.status).toBe(200);
    expect(await legitimate.json()).toEqual({ realm: "A", sub: "user-a" });

    // Symmetrically for tenant B.
    expect((await app.inject({ url: "/tenant-b/me", headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(
      401,
    );
    expect((await app.inject({ url: "/tenant-b/me", headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(
      200,
    );
  });

  it("isolates realms today when each guard is bound to its realm via jwt(...).guard()", async () => {
    // The realm-bound guard resolves no ambient request state, so it is correct
    // regardless of how the core resolves request decorations.
    const { app, realmA, realmB } = await buildTwoRealmApp((realm) => realm.guard());

    const tokenA = await realmA.sign({ sub: "user-a" });
    const tokenB = await realmB.sign({ sub: "user-b" });

    expect((await app.inject({ url: "/tenant-a/me", headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(
      401,
    );
    expect((await app.inject({ url: "/tenant-b/me", headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(
      401,
    );

    const aSelf = await app.inject({ url: "/tenant-a/me", headers: { authorization: `Bearer ${tokenA}` } });
    expect(aSelf.status).toBe(200);
    expect(await aSelf.json()).toEqual({ realm: "A", sub: "user-a" });

    const bSelf = await app.inject({ url: "/tenant-b/me", headers: { authorization: `Bearer ${tokenB}` } });
    expect(bSelf.status).toBe(200);
    expect(await bSelf.json()).toEqual({ realm: "B", sub: "user-b" });
  });

  it("isolates realms today when each guard carries an explicit secret", async () => {
    const explicitA = jwt({ secret: SECRET_A });
    const explicitB = jwt({ secret: SECRET_B });
    const twoRealmApp = createApp();

    await twoRealmApp.register(
      async (tenant) => {
        await tenant.register(explicitA, { encapsulate: false });
        tenant.addHook("preHandler", createJWTGuard({ secret: SECRET_A }));
        tenant.get("/me", (_req, reply) => reply.json({ realm: "A" }));
      },
      { prefix: "/tenant-a" },
    );
    await twoRealmApp.register(
      async (tenant) => {
        await tenant.register(explicitB, { encapsulate: false });
        tenant.addHook("preHandler", createJWTGuard({ secret: SECRET_B }));
        tenant.get("/me", (_req, reply) => reply.json({ realm: "B" }));
      },
      { prefix: "/tenant-b" },
    );

    const tokenB = await explicitB.sign({ sub: "user-b" });
    expect(
      (await twoRealmApp.inject({ url: "/tenant-a/me", headers: { authorization: `Bearer ${tokenB}` } })).status,
    ).toBe(401);
    expect(
      (await twoRealmApp.inject({ url: "/tenant-b/me", headers: { authorization: `Bearer ${tokenB}` } })).status,
    ).toBe(200);
  });
});

/**
 * The ambient-guard edge left over after the realm-isolation fix.
 *
 * Realm isolation INSIDE a prefix was correct, but a route outside every realm's
 * context fell through to the app-wide compatibility fallback, which is
 * last-writer-wins. Proven: on a root route, realm A's token got a 401 while
 * realm B's got a 200 with B's subject. Authenticating against an arbitrary
 * tenant is worse than not authenticating at all, so it now fails closed.
 */
describe("unbound createJWTGuard() outside every realm", () => {
  async function buildRootGuardedApp(realmCount: 1 | 2) {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    await app.register(
      async (tenant) => {
        await tenant.register(realmA, { encapsulate: false });
        tenant.get("/me", (_req, reply) => reply.json({ realm: "A" }));
      },
      { prefix: "/a" },
    );

    if (realmCount === 2) {
      await app.register(
        async (tenant) => {
          await tenant.register(realmB, { encapsulate: false });
          tenant.get("/me", (_req, reply) => reply.json({ realm: "B" }));
        },
        { prefix: "/b" },
      );
    }

    app.get("/root", { preHandler: createJWTGuard() }, (req, reply) =>
      reply.json({ sub: (req as { user?: { sub?: string } }).user?.sub }),
    );
    await app.ready();

    return { app, realmA, realmB };
  }

  it("refuses to authenticate against an arbitrary realm when two are registered", async () => {
    const { app, realmA, realmB } = await buildRootGuardedApp(2);

    // Before the fix this was 200 {"sub":"userB"}: the LAST-registered realm
    // silently became the ambient one.
    const withB = await app.inject({
      url: "/root",
      headers: { authorization: `Bearer ${await realmB.sign({ sub: "user-b" })}` },
    });
    expect(withB.status).not.toBe(200);

    const withA = await app.inject({
      url: "/root",
      headers: { authorization: `Bearer ${await realmA.sign({ sub: "user-a" })}` },
    });
    expect(withA.status).not.toBe(200);
  });

  it("names the actionable fix in the error", async () => {
    const { app, realmB } = await buildRootGuardedApp(2);
    const messages: string[] = [];
    app.setErrorHandler((error) => {
      messages.push(error.message);
      return new Response("handled", { status: 500 });
    });

    await app.inject({ url: "/root", headers: { authorization: `Bearer ${await realmB.sign({ sub: "user-b" })}` } });

    expect(messages[0]).toMatch(/2 JWT realms/);
    expect(messages[0]).toMatch(/jwt\(\.\.\.\)\.guard\(\)/);
    expect(messages[0]).toMatch(/createJWTGuard\(\{ secret \}\)/);
  });

  it("keeps the single-realm fallback working", async () => {
    const { app, realmA } = await buildRootGuardedApp(1);

    const ok = await app.inject({
      url: "/root",
      headers: { authorization: `Bearer ${await realmA.sign({ sub: "user-a" })}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sub: "user-a" });
  });

  it("still resolves the right realm for routes INSIDE a realm's scope", async () => {
    const realmA = jwt({ secret: SECRET_A });
    const realmB = jwt({ secret: SECRET_B });
    const app = createApp();

    const mount = (realm: ReturnType<typeof jwt>, name: string, prefix: string) =>
      app.register(
        async (tenant) => {
          await tenant.register(realm, { encapsulate: false });
          tenant.addHook("preHandler", createJWTGuard());
          tenant.get("/me", (req, reply) =>
            reply.json({ realm: name, sub: (req as { user?: { sub?: string } }).user?.sub }),
          );
        },
        { prefix },
      );

    await mount(realmA, "A", "/a");
    await mount(realmB, "B", "/b");
    await app.ready();

    const tokenA = await realmA.sign({ sub: "user-a" });
    const self = await app.inject({ url: "/a/me", headers: { authorization: `Bearer ${tokenA}` } });
    expect(self.status).toBe(200);
    expect(await self.json()).toEqual({ realm: "A", sub: "user-a" });
    expect((await app.inject({ url: "/b/me", headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(401);
  });
});
