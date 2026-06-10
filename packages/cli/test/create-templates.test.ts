// @celsian/cli — `celsian create` template behavior tests
// Validates the shared create-celsian templates against the actual core
// runtime in this repo (CSRF semantics, schema validation).

import { createApp, csrf } from "@celsian/core";
import { Type } from "@sinclair/typebox";
import { templates } from "create-celsian";
import { describe, expect, it } from "vitest";

describe("celsian create — template registry", () => {
  it("exposes all 4 templates (including full)", () => {
    expect(Object.keys(templates).sort()).toEqual(["basic", "full", "rest-api", "rpc-api"]);
  });

  it("no template pins a stale celsian version", () => {
    for (const [name, files] of Object.entries(templates)) {
      const pkg = JSON.parse(files["package.json"]);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [dep, version] of Object.entries(deps)) {
        if (dep === "celsian" || dep.startsWith("@celsian/")) {
          expect(version, `${name} -> ${dep}`).toBe("^0.5.0");
        }
      }
    }
  });

  it("basic/rest-api/rpc-api ship .gitignore and README.md", () => {
    for (const name of ["basic", "rest-api", "rpc-api"]) {
      const files = Object.keys(templates[name]);
      expect(files, name).toContain(".gitignore");
      expect(files, name).toContain("README.md");
      expect(templates[name][".gitignore"]).toContain("node_modules");
      expect(templates[name][".gitignore"]).toContain("dist");
      expect(templates[name][".gitignore"]).toContain(".env");
    }
  });
});

describe("rest-api template — user creation passes validation", () => {
  // Recreate the exact schema the template scaffolds (pattern is extracted
  // from the template source, so this fails if the template regresses).
  function templateEmailSchema() {
    const match = templates["rest-api"]["src/index.ts"].match(/pattern: '([^']+)'/) ?? [];
    expect(match[1]).toBeDefined();
    const pattern = (match[1] ?? "").replace(/\\\\/g, "\\");
    return Type.Object({
      name: Type.String(),
      email: Type.String({ pattern }),
    });
  }

  it("accepts a valid email (no 'Unknown format' failure)", async () => {
    const app = createApp();
    app.post("/users", { schema: { body: templateEmailSchema() } }, (req, reply) => {
      const { name, email } = req.parsedBody as { name: string; email: string };
      return reply.status(201).json({ id: 1, name, email });
    });

    const res = await app.inject({
      method: "POST",
      url: "/users",
      payload: { name: "Ada", email: "ada@example.com" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe("ada@example.com");
  });

  it("still rejects an invalid email with 400", async () => {
    const app = createApp();
    app.post("/users", { schema: { body: templateEmailSchema() } }, (_req, reply) => {
      return reply.status(201).json({ ok: true });
    });

    const res = await app.inject({
      method: "POST",
      url: "/users",
      payload: { name: "Ada", email: "not-an-email" },
    });
    expect(res.status).toBe(400);
  });
});

describe("full template — CSRF excludes work against core's exact matching", () => {
  function templateExcludePaths(): string[] {
    const security = templates.full["src/plugins/security.ts"];
    const arrayMatch = security.match(/excludePaths: \[([^\]]*)\]/) ?? [];
    expect(arrayMatch[1]).toBeDefined();
    const paths = [...(arrayMatch[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    return paths;
  }

  it("a scaffolded RPC mutation POST is not blocked by CSRF", async () => {
    const app = createApp();
    await app.register(csrf({ excludePaths: templateExcludePaths() }), { encapsulate: false });
    app.route({
      method: ["GET", "POST"],
      url: "/_rpc/*path",
      handler: (_req, reply) => reply.json({ result: { result: 42 } }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/_rpc/math.multiply",
      payload: { a: 6, b: 7 },
    });
    expect(res.status).toBe(200);
  });

  it("non-excluded mutations are still CSRF-protected", async () => {
    const app = createApp();
    await app.register(csrf({ excludePaths: templateExcludePaths() }), { encapsulate: false });
    app.post("/users", (_req, reply) => reply.status(201).json({ ok: true }));

    const res = await app.inject({ method: "POST", url: "/users", payload: { name: "x" } });
    expect(res.status).toBe(403);
  });
});
