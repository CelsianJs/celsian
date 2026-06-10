import { describe, expect, it } from "vitest";
// Relative import: @celsian/core is not a dependency of @celsian/rpc (the
// handler is framework-agnostic), but the mount() helper targets CelsianApp
// structurally — so the integration test pulls core straight from the workspace.
import { createApp } from "../../core/src/index.js";
import { procedure } from "../src/procedure.js";
import { RPCHandler, router } from "../src/router.js";

function buildHandler() {
  const routes = router({
    greet: procedure.query(async ({ input }) => {
      return { message: `Hello, ${(input as { name: string }).name}!` };
    }),
    counter: {
      bump: procedure.mutation(async ({ input }) => {
        return { next: (input as { n: number }).n + 1 };
      }),
    },
  });
  return new RPCHandler(routes);
}

describe("RPCHandler.mount()", () => {
  it("registers GET (query) and POST (mutation) routes on a CelsianApp", async () => {
    const app = createApp();
    const rpc = buildHandler();
    rpc.mount(app);

    // Query over GET with ?input=<json>
    const input = encodeURIComponent(JSON.stringify({ name: "Ada" }));
    const queryRes = await app.inject({ url: `/_rpc/greet?input=${input}` });
    expect(queryRes.status).toBe(200);
    const queryBody = await queryRes.json();
    expect(queryBody.result).toEqual({ message: "Hello, Ada!" });

    // Mutation over POST with JSON body
    const mutateRes = await app.inject({
      method: "POST",
      url: "/_rpc/counter.bump",
      headers: { "content-type": "application/json" },
      payload: { n: 41 },
    });
    expect(mutateRes.status).toBe(200);
    const mutateBody = await mutateRes.json();
    expect(mutateBody.result).toEqual({ next: 42 });
  });

  it("rejects mutations over GET (405) when mounted", async () => {
    const app = createApp();
    const rpc = buildHandler();
    rpc.mount(app);

    const res = await app.inject({ url: "/_rpc/counter.bump" });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("mounts at a custom prefix", async () => {
    const app = createApp();
    const rpc = buildHandler();
    rpc.mount(app, "/api/rpc");

    const input = encodeURIComponent(JSON.stringify({ name: "Grace" }));
    const res = await app.inject({ url: `/api/rpc/greet?input=${input}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toEqual({ message: "Hello, Grace!" });

    // The old default prefix is not registered.
    const oldPrefix = await app.inject({ url: `/_rpc/greet?input=${input}` });
    expect(oldPrefix.status).toBe(404);
  });

  it("serves manifest.json through the mounted routes", async () => {
    const app = createApp();
    const rpc = buildHandler();
    rpc.mount(app);

    const res = await app.inject({ url: "/_rpc/manifest.json" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.procedures["counter.bump"].type).toBe("mutation");
  });
});
