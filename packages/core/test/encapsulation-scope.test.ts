import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { runHooksFireAndForget } from "../src/hooks.js";
import type { CelsianReply, CelsianRequest, HookHandler, PluginContext } from "../src/types.js";

// ─── TASK-1.1 / CRIT-1: plugin request hooks must reach the routes they guard ───

describe("plugin request hooks reach app routes", () => {
  it("runs an un-prefixed plugin's onRequest hook on a route registered on the app", async () => {
    const app = createApp();

    await app.register(async (plugin: PluginContext) => {
      plugin.addHook("onRequest", () => new Response("blocked", { status: 403 }));
    });

    app.post("/transfer", () => ({ ok: true }));

    const res = await app.inject({ method: "POST", url: "/transfer" });
    expect(res.status).toBe(403);
  });

  it("runs an un-prefixed plugin's preHandler hook on a route registered on the app", async () => {
    const app = createApp();
    const seen: string[] = [];

    await app.register(async (plugin: PluginContext) => {
      plugin.addHook("preHandler", () => {
        seen.push("preHandler");
      });
    });

    app.get("/x", () => ({ ok: true }));

    await app.inject({ url: "/x" });
    expect(seen).toEqual(["preHandler"]);
  });

  it("runs a plugin-scoped preParsing hook (previously read only from the root context)", async () => {
    const app = createApp();
    const seen: string[] = [];

    await app.register(async (plugin: PluginContext) => {
      plugin.addHook("preParsing", () => {
        seen.push("preParsing");
      });
      plugin.addHook("preValidation", () => {
        seen.push("preValidation");
      });
    });

    app.get("/x", () => ({ ok: true }));

    await app.inject({ url: "/x" });
    expect(seen).toEqual(["preParsing", "preValidation"]);
  });

  it("runs a plugin-scoped onError hook", async () => {
    const app = createApp();
    let caught: string | null = null;

    await app.register(async (plugin: PluginContext) => {
      plugin.addHook("onError", (error: Error) => {
        caught = error.message;
      });
    });

    app.get("/boom", () => {
      throw new Error("kaboom");
    });

    await app.inject({ url: "/boom" });
    expect(caught).toBe("kaboom");
  });

  it("registration order does not matter: plugin registered after the route still guards it", async () => {
    const app = createApp();

    app.post("/transfer", () => ({ ok: true }));

    await app.register(async (plugin: PluginContext) => {
      plugin.addHook("onRequest", () => new Response("blocked", { status: 403 }));
    });

    const res = await app.inject({ method: "POST", url: "/transfer" });
    expect(res.status).toBe(403);
  });
});

// ─── TASK-1.2 / H-4: hooks added after route registration ───

describe("hooks added after route registration", () => {
  it("applies an onRequest hook added after the route was registered", async () => {
    const app = createApp();

    app.get("/admin", () => ({ secret: true }));
    app.addHook("onRequest", () => new Response("blocked", { status: 401 }));

    const res = await app.inject({ url: "/admin" });
    expect(res.status).toBe(401);
  });

  it("applies a preHandler hook added after the route was registered", async () => {
    const app = createApp();

    app.get("/late", () => ({ ok: true }));
    app.addHook("preHandler", (_req, reply) => {
      reply.header("x-late", "yes");
    });

    const res = await app.inject({ url: "/late" });
    expect(res.headers.get("x-late")).toBe("yes");
  });

  it("keeps applying hooks added between two requests", async () => {
    const app = createApp();
    app.get("/x", () => ({ ok: true }));

    const first = await app.inject({ url: "/x" });
    expect(first.status).toBe(200);

    app.addHook("onRequest", () => new Response(null, { status: 418 }));

    const second = await app.inject({ url: "/x" });
    expect(second.status).toBe(418);
  });
});

// ─── TASK-1.3 / CRIT-3: plugin-scoped request decorations ───

describe("plugin-scoped request decorations", () => {
  it("applies a plugin's default-scope decorateRequest to routes in that scope", async () => {
    const app = createApp();

    await app.register(async (plugin: PluginContext) => {
      plugin.decorateRequest("tenant", "acme");
      plugin.get("/inside", (req) => ({ tenant: req.tenant }));
    });

    const res = await app.inject({ url: "/inside" });
    expect(await res.json()).toEqual({ tenant: "acme" });
  });

  it("applies an un-prefixed plugin's decorateRequest to routes registered on the app", async () => {
    const app = createApp();

    await app.register(async (plugin: PluginContext) => {
      plugin.decorateRequest("tenant", "acme");
    });

    app.get("/outside", (req) => ({ tenant: req.tenant }));

    const res = await app.inject({ url: "/outside" });
    expect(await res.json()).toEqual({ tenant: "acme" });
  });

  it("keeps a prefixed plugin's decorateRequest inside its prefix", async () => {
    const app = createApp();

    await app.register(
      async (plugin: PluginContext) => {
        plugin.decorateRequest("scopedOnly", "yes");
        plugin.get("/inside", (req) => ({ value: req.scopedOnly ?? null }));
      },
      { prefix: "/admin" },
    );

    app.get("/public", (req) => ({ value: req.scopedOnly ?? null }));

    expect(await (await app.inject({ url: "/admin/inside" })).json()).toEqual({ value: "yes" });
    expect(await (await app.inject({ url: "/public" })).json()).toEqual({ value: null });
  });

  it("lets a nearer scope override an outer decoration", async () => {
    const app = createApp();
    app.decorateRequest("tier", "free");

    await app.register(
      async (plugin: PluginContext) => {
        plugin.decorateRequest("tier", "pro");
        plugin.get("/inside", (req) => ({ tier: req.tier }));
      },
      { prefix: "/pro" },
    );

    app.get("/outside", (req) => ({ tier: req.tier }));

    expect(await (await app.inject({ url: "/pro/inside" })).json()).toEqual({ tier: "pro" });
    expect(await (await app.inject({ url: "/outside" })).json()).toEqual({ tier: "free" });
  });

  it('still hoists to the root with scope: "app" from inside a prefixed plugin', async () => {
    const app = createApp();

    await app.register(
      async (plugin: PluginContext) => {
        plugin.decorateRequest("global", "everywhere", { scope: "app" });
      },
      { prefix: "/admin" },
    );

    app.get("/public", (req) => ({ value: req.global ?? null }));

    expect(await (await app.inject({ url: "/public" })).json()).toEqual({ value: "everywhere" });
  });
});

// ─── TASK-1.4: onSend / onResponse must respect the prefix boundary ───

describe("onSend and onResponse respect encapsulation", () => {
  it("does not run a prefixed plugin's onSend hook on a route outside the prefix", async () => {
    const app = createApp();

    await app.register(
      async (plugin: PluginContext) => {
        plugin.addHook("onSend", (_req, reply) => {
          reply.header("x-admin-only", "yes");
        });
        plugin.get("/inside", () => ({ ok: true }));
      },
      { prefix: "/admin" },
    );

    app.get("/public", () => ({ ok: true }));

    const inside = await app.inject({ url: "/admin/inside" });
    expect(inside.headers.get("x-admin-only")).toBe("yes");

    const outside = await app.inject({ url: "/public" });
    expect(outside.headers.get("x-admin-only")).toBeNull();
  });

  it("does not run a prefixed plugin's onResponse hook on a route outside the prefix", async () => {
    const app = createApp();
    const seen: string[] = [];

    await app.register(
      async (plugin: PluginContext) => {
        plugin.addHook("onResponse", (req) => {
          seen.push(new URL(req.url, "http://localhost").pathname);
        });
        plugin.get("/inside", () => ({ ok: true }));
      },
      { prefix: "/admin" },
    );

    app.get("/public", () => ({ ok: true }));

    await app.inject({ url: "/public" });
    await app.inject({ url: "/admin/inside" });

    expect(seen).toEqual(["/admin/inside"]);
  });

  it("keeps an un-prefixed plugin's onSend hook application-wide", async () => {
    const app = createApp();

    await app.register(async (plugin: PluginContext) => {
      plugin.addHook("onSend", (_req, reply) => {
        reply.header("x-global", "yes");
      });
    });

    app.get("/public", () => ({ ok: true }));

    const res = await app.inject({ url: "/public" });
    expect(res.headers.get("x-global")).toBe("yes");
  });

  it("runs hooks root-first, then plugin, then route-level", async () => {
    const app = createApp();
    const order: string[] = [];

    app.addHook("onRequest", () => {
      order.push("root");
    });

    await app.register(async (plugin: PluginContext) => {
      plugin.addHook("onRequest", () => {
        order.push("plugin");
      });
      plugin.get(
        "/x",
        {
          onRequest: () => {
            order.push("route");
          },
        },
        () => ({ ok: true }),
      );
    });

    await app.inject({ url: "/x" });
    expect(order).toEqual(["root", "plugin", "route"]);
  });
});

// ─── TASK-1.5: synchronous throws in fire-and-forget hooks ───

describe("fire-and-forget hook errors", () => {
  it("reports a synchronous throw instead of swallowing it", () => {
    const logger = { error: vi.fn() };
    const boom: HookHandler = () => {
      throw new Error("sync boom");
    };

    runHooksFireAndForget([boom], {} as CelsianRequest, {} as CelsianReply, logger);

    expect(logger.error).toHaveBeenCalledWith("fire-and-forget hook error", { error: "sync boom" });
  });

  it("keeps running later hooks after one throws synchronously", () => {
    const logger = { error: vi.fn() };
    const seen: string[] = [];
    const boom: HookHandler = () => {
      throw new Error("sync boom");
    };
    const ok: HookHandler = () => {
      seen.push("ok");
    };

    runHooksFireAndForget([boom, ok], {} as CelsianRequest, {} as CelsianReply, logger);

    expect(seen).toEqual(["ok"]);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("reports a synchronous throw from an onResponse hook during a request", async () => {
    const app = createApp();
    const errorSpy = vi.spyOn(app.log, "error");

    app.addHook("onResponse", () => {
      throw new Error("onResponse boom");
    });
    app.get("/x", () => ({ ok: true }));

    const res = await app.inject({ url: "/x" });

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith("fire-and-forget hook error", { error: "onResponse boom" });
  });
});
