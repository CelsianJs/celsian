// @celsian/jwt — two auth realms on ONE app must not cross-authenticate (CRIT-3)

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
