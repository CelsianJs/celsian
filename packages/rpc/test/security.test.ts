// @celsian/rpc -- security regressions for the 0.6.0 hardening pass.
//
// H-7  prototype injection through decode()
// H-9  CSRF-able mutations via CORS-simple content types
// M-12 unauthenticated, unconditional introspection endpoints
//
// Every test here fails against the pre-fix handler.

import { describe, expect, it, vi } from "vitest";
import { procedure } from "../src/procedure.js";
import { RPCHandler, router } from "../src/router.js";
import { decode } from "../src/wire.js";

const JSON_HEADERS = { "content-type": "application/json" };

// ─── H-7: prototype injection ───

describe("H-7: decode() must not perform a prototype assignment from client input", () => {
  // JSON.parse keeps __proto__ as an own ENUMERABLE property, so a naive
  // `result[k] = ...` copy fires Object.prototype.__proto__'s setter. The result
  // is object-LOCAL prototype substitution: Object.keys() omits the injected
  // fields while property reads see them, which is exactly what defeats
  // allow-list guards written as Object.keys(input).forEach(...).
  const payload = '{"__proto__":{"isAdmin":true},"name":"bob"}';

  it("drops __proto__ instead of re-parenting the decoded object", () => {
    const decoded = decode(JSON.parse(payload)) as Record<string, unknown>;

    expect(decoded.name).toBe("bob");
    expect((decoded as { isAdmin?: boolean }).isAdmin).toBeUndefined();
    expect(Object.keys(decoded)).toEqual(["name"]);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  it("drops constructor and prototype keys too", () => {
    const decoded = decode(JSON.parse('{"constructor":{"x":1},"prototype":{"y":2},"ok":true}')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(decoded)).toEqual(["ok"]);
  });

  it("drops them at every nesting level", () => {
    const decoded = decode(JSON.parse('{"a":{"b":[{"__proto__":{"isAdmin":true},"id":1}]}}')) as {
      a: { b: Array<Record<string, unknown>> };
    };
    const leaf = decoded.a.b[0]!;
    expect(Object.keys(leaf)).toEqual(["id"]);
    expect((leaf as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it("never pollutes the global Object.prototype", () => {
    decode(JSON.parse(payload));
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it("blocks the GET ?input= path, which never reaches core's body scrub", async () => {
    const handler = new RPCHandler(
      router({
        me: procedure.query(async ({ input }) => ({
          isAdmin: (input as { isAdmin?: boolean }).isAdmin ?? false,
          keys: Object.keys(input as object),
        })),
      }),
    );

    const url = `http://localhost/_rpc/me?input=${encodeURIComponent(payload)}`;
    const body = await (await handler.handle(new Request(url))).json();

    expect(body.result).toEqual({ isAdmin: false, keys: ["name"] });
  });

  it("blocks the standalone POST path (no CelsianApp body scrub in front)", async () => {
    const handler = new RPCHandler(
      router({
        save: procedure.mutation(async ({ input }) => ({
          isAdmin: (input as { isAdmin?: boolean }).isAdmin ?? false,
          keys: Object.keys(input as object),
        })),
      }),
    );

    const res = await handler.handle(
      new Request("http://localhost/_rpc/save", { method: "POST", headers: JSON_HEADERS, body: payload }),
    );
    expect(await res.json()).toEqual({ result: { isAdmin: false, keys: ["name"] } });
  });
});

describe("H-7 companion: decode() depth cap", () => {
  function nest(depth: number): string {
    return `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  }

  it("decodes payloads within the 32-level cap", () => {
    expect(() => decode(JSON.parse(nest(30)))).not.toThrow();
  });

  it("rejects payloads past the cap instead of recursing without bound", () => {
    expect(() => decode(JSON.parse(nest(200)))).toThrow(/nests deeper than the maximum/);
  });

  it("accounts for the nested JSON.parse inside Set/Map tags", () => {
    const deepSet = { __t: "Set", v: JSON.stringify([JSON.parse(nest(200))]) };
    expect(() => decode(deepSet)).toThrow(/nests deeper than the maximum/);
  });

  it("rejects a Set/Map tag whose payload is not an array", () => {
    expect(() => decode({ __t: "Map", v: '{"not":"an array"}' })).toThrow(/must encode an array/);
  });

  it("still surfaces as a clean 400 rather than a crash", async () => {
    const handler = new RPCHandler(router({ echo: procedure.query(async ({ input }) => input) }));
    const url = `http://localhost/_rpc/echo?input=${encodeURIComponent(nest(200))}`;
    const res = await handler.handle(new Request(url));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("PARSE_ERROR");
  });
});

// ─── H-9: CSRF ───

describe("H-9: mutations must not be reachable by a cross-origin HTML form", () => {
  function makeHandler(options?: ConstructorParameters<typeof RPCHandler>[1]) {
    return new RPCHandler(
      router({
        del: procedure.mutation(async () => ({ deleted: true })),
        upload: procedure
          .allowFormData()
          .mutation(async ({ input }) => ({ got: input instanceof FormData ? "formdata" : typeof input })),
        read: procedure.query(async () => ({ secret: "s3cret" })),
      }),
      options,
    );
  }

  it("rejects multipart/form-data on a mutation (415)", async () => {
    const form = new FormData();
    form.set("x", "1");
    const res = await makeHandler().handle(new Request("http://localhost/_rpc/del", { method: "POST", body: form }));

    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects application/x-www-form-urlencoded, also a CORS-simple type", async () => {
    const res = await makeHandler().handle(
      new Request("http://localhost/_rpc/del", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "x=1",
      }),
    );
    expect(res.status).toBe(415);
  });

  it("rejects text/plain, the third CORS-simple type", async () => {
    const res = await makeHandler().handle(
      new Request("http://localhost/_rpc/del", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(415);
  });

  it("rejects a POST with no content-type at all", async () => {
    const res = await makeHandler().handle(new Request("http://localhost/_rpc/del", { method: "POST" }));
    expect(res.status).toBe(415);
  });

  it("still accepts form data on a procedure that opted in", async () => {
    const form = new FormData();
    form.set("file", "contents");
    const res = await makeHandler().handle(new Request("http://localhost/_rpc/upload", { method: "POST", body: form }));

    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual({ got: "formdata" });
  });

  it("rejects a cross-origin Origin header on a mutation (403)", async () => {
    const res = await makeHandler().handle(
      new Request("http://localhost/_rpc/del", {
        method: "POST",
        headers: { ...JSON_HEADERS, origin: "https://attacker.example" },
        body: "{}",
      }),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("CROSS_ORIGIN_DENIED");
  });

  it("rejects Sec-Fetch-Site: cross-site even without an Origin header", async () => {
    const res = await makeHandler().handle(
      new Request("http://localhost/_rpc/del", {
        method: "POST",
        headers: { ...JSON_HEADERS, "sec-fetch-site": "cross-site" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects Sec-Fetch-Site: same-site (a sibling subdomain shares cookies)", async () => {
    const res = await makeHandler().handle(
      new Request("http://localhost/_rpc/del", {
        method: "POST",
        headers: { ...JSON_HEADERS, "sec-fetch-site": "same-site" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("applies the origin check to query procedures invoked over POST", async () => {
    const res = await makeHandler().handle(
      new Request("http://localhost/_rpc/read", {
        method: "POST",
        headers: { ...JSON_HEADERS, origin: "https://attacker.example" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("allows a same-origin browser request", async () => {
    const res = await makeHandler().handle(
      new Request("http://localhost/_rpc/del", {
        method: "POST",
        headers: { ...JSON_HEADERS, origin: "http://localhost", "sec-fetch-site": "same-origin" },
        body: "{}",
      }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual({ deleted: true });
  });

  it("allows an explicitly allow-listed cross-origin frontend", async () => {
    const handler = makeHandler({ allowedOrigins: ["https://app.example"] });
    const res = await handler.handle(
      new Request("http://localhost/_rpc/del", {
        method: "POST",
        headers: { ...JSON_HEADERS, origin: "https://app.example" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("allows non-browser clients that send neither header", async () => {
    const res = await makeHandler().handle(
      new Request("http://localhost/_rpc/del", { method: "POST", headers: JSON_HEADERS, body: "{}" }),
    );
    expect(res.status).toBe(200);
  });

  it("can be turned off explicitly with originCheck: false", async () => {
    const handler = makeHandler({ originCheck: false });
    const res = await handler.handle(
      new Request("http://localhost/_rpc/del", {
        method: "POST",
        headers: { ...JSON_HEADERS, origin: "https://attacker.example" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ─── M-12: introspection ───

describe("M-12: introspection endpoints must be gated", () => {
  const routes = router({
    "admin.deleteEverything": procedure.mutation(async () => ({ ok: true })),
    "internal.dumpSecrets": procedure.query(async () => ({ ok: true })),
  });

  it("serves introspection in development by default", async () => {
    const handler = new RPCHandler(routes);
    for (const path of ["manifest.json", "openapi.json"]) {
      const res = await handler.handle(new Request(`http://localhost/_rpc/${path}`));
      expect(res.status).toBe(200);
    }
  });

  it("does NOT serve introspection in production by default", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const handler = new RPCHandler(routes);
      for (const path of ["manifest.json", "openapi.json"]) {
        const res = await handler.handle(new Request(`http://localhost/_rpc/${path}`));
        expect(res.status).toBe(404);
        // Indistinguishable from an unknown procedure, no confirmation that
        // introspection merely got switched off.
        expect((await res.json()).error.code).toBe("NOT_FOUND");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("honors CELSIAN_ENV=production as well", async () => {
    vi.stubEnv("CELSIAN_ENV", "production");
    try {
      const res = await new RPCHandler(routes).handle(new Request("http://localhost/_rpc/manifest.json"));
      expect(res.status).toBe(404);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("can be disabled outright with introspection: false", async () => {
    const handler = new RPCHandler(routes, { introspection: false });
    const res = await handler.handle(new Request("http://localhost/_rpc/manifest.json"));
    expect(res.status).toBe(404);
  });

  it("can be force-enabled in production with introspection: true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const handler = new RPCHandler(routes, { introspection: true });
      const res = await handler.handle(new Request("http://localhost/_rpc/manifest.json"));
      expect(res.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs introspectionMiddlewares before serving, so the dump can require auth", async () => {
    const seen: string[] = [];
    const handler = new RPCHandler(routes, {
      introspection: true,
      introspectionMiddlewares: [
        async ({ ctx, next }) => {
          seen.push("guard");
          if (!ctx.request.headers.get("authorization")) {
            const err = new Error("Unauthorized") as Error & { statusCode: number; code: string };
            err.statusCode = 401;
            err.code = "UNAUTHORIZED";
            throw err;
          }
          return next();
        },
      ],
    });

    const denied = await handler.handle(new Request("http://localhost/_rpc/manifest.json"));
    expect(denied.status).toBe(401);
    expect((await denied.json()).error.code).toBe("UNAUTHORIZED");

    const allowed = await handler.handle(
      new Request("http://localhost/_rpc/openapi.json", { headers: { authorization: "Bearer t" } }),
    );
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).paths["/_rpc/admin.deleteEverything"]).toBeDefined();
    expect(seen).toEqual(["guard", "guard"]);
  });

  it("does not leak procedure names when the guard rejects", async () => {
    const handler = new RPCHandler(routes, {
      introspection: true,
      introspectionMiddlewares: [
        async () => {
          const err = new Error("nope") as Error & { statusCode: number };
          err.statusCode = 403;
          throw err;
        },
      ],
    });

    const res = await handler.handle(new Request("http://localhost/_rpc/manifest.json"));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("deleteEverything");
  });
});

// ─── LOW batch: logger ───

describe("RPCHandler logger option", () => {
  const failing = router({
    boom: procedure.query(async () => {
      throw new Error("kaboom");
    }),
  });

  it("routes 5xx detail through a supplied logger instead of console.error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const logged: Array<{ msg: string; data?: Record<string, unknown> }> = [];
      const handler = new RPCHandler(failing, {
        logger: {
          error(msg, data) {
            logged.push({ msg, data });
          },
        },
      });

      const res = await handler.handle(new Request("http://localhost/_rpc/boom"));

      expect(res.status).toBe(500);
      expect(logged).toHaveLength(1);
      expect(logged[0]!.msg).toContain('procedure "boom" error');
      expect((logged[0]!.data?.err as { message: string }).message).toBe("kaboom");
      // The raw console must be left alone once a logger is configured.
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("still falls back to console.error when no logger is supplied", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await new RPCHandler(failing).handle(new Request("http://localhost/_rpc/boom"));
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("maps a throwing input schema to a response instead of rejecting handle()", async () => {
    // Input validation used to run OUTSIDE the try/catch, so a schema adapter
    // that throws (async schema, misconfiguration) escaped handle() entirely.
    const logged: string[] = [];
    const handler = new RPCHandler(
      router({
        boom: procedure
          .input({
            validate() {
              throw new Error("schema exploded");
            },
            toJsonSchema: () => ({ type: "object" }),
          })
          .query(async () => ({ ok: true })),
      }),
      {
        logger: {
          error(msg) {
            logged.push(msg);
          },
        },
      },
    );

    const res = await handler.handle(new Request("http://localhost/_rpc/boom?input=%7B%7D"));
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toBe("schema exploded");
    expect(logged).toHaveLength(1);
  });

  it("maps a throwing contextFactory to a response as well", async () => {
    const handler = new RPCHandler(router({ ok: procedure.query(async () => ({ ok: true })) }), {
      contextFactory: () => {
        const err = new Error("no session") as Error & { statusCode: number };
        err.statusCode = 401;
        throw err;
      },
    });

    const res = await handler.handle(new Request("http://localhost/_rpc/ok"));
    expect(res.status).toBe(401);
  });

  it("does not log expected 4xx errors", async () => {
    const logged: string[] = [];
    const handler = new RPCHandler(
      router({
        nope: procedure.query(async () => {
          const err = new Error("bad request") as Error & { statusCode: number };
          err.statusCode = 400;
          throw err;
        }),
      }),
      {
        logger: {
          error(msg) {
            logged.push(msg);
          },
        },
      },
    );

    const res = await handler.handle(new Request("http://localhost/_rpc/nope"));
    expect(res.status).toBe(400);
    expect(logged).toEqual([]);
  });
});
