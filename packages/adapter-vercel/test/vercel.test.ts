import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cors, createApp } from "@celsian/core";
import { build } from "esbuild";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createVercelCronHandler, createVercelEdgeHandler } from "../src/index.js";

function makeRequest(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

async function handle(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const handler = createVercelEdgeHandler(app);
  return handler(makeRequest(path, init));
}

describe("@celsian/adapter-vercel (Edge)", () => {
  it("should create an edge handler from app.fetch", () => {
    const app = createApp();
    const handler = createVercelEdgeHandler(app);
    expect(typeof handler).toBe("function");
  });

  it("should handle GET requests", async () => {
    const app = createApp();
    app.get("/hello", (_req, reply) => reply.json({ message: "hello" }));

    const response = await handle(app, "/hello");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "hello" });
  });

  it("should parse URL params", async () => {
    const app = createApp();
    app.get("/users/:id", (req, reply) => reply.json({ id: req.params.id }));

    const response = await handle(app, "/users/42");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "42" });
  });

  it("should parse query strings", async () => {
    const app = createApp();
    app.get("/search", (req, reply) => reply.json({ q: req.query.q }));

    const response = await handle(app, "/search?q=test");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ q: "test" });
  });

  it("should handle POST with JSON body", async () => {
    const app = createApp();
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody }));

    const response = await handle(app, "/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: { name: "test" } });
  });

  it("should return 404 for unmatched routes", async () => {
    const app = createApp();
    const response = await handle(app, "/nope");
    expect(response.status).toBe(404);
  });

  it("should return 405 for wrong method", async () => {
    const app = createApp();
    app.get("/only-get", (_req, reply) => reply.json({ ok: true }));

    const response = await handle(app, "/only-get", { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("should handle HEAD requests (fallback to GET)", async () => {
    const app = createApp();
    app.get("/hello", (_req, reply) => reply.json({ message: "hello" }));

    const response = await handle(app, "/hello", { method: "HEAD" });
    expect(response.status).toBe(200);
  });

  it("should reject oversized body", async () => {
    const app = createApp({ bodyLimit: 100 });
    app.post("/data", (_req, reply) => reply.json({ ok: true }));

    const response = await handle(app, "/data", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1000000" },
      body: JSON.stringify({ big: "x".repeat(1000) }),
    });
    expect(response.status).toBe(413);
  });

  it("should return 400 for malformed JSON", async () => {
    const app = createApp();
    app.post("/data", (_req, reply) => reply.json({ ok: true }));

    const response = await handle(app, "/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken json",
    });
    expect(response.status).toBe(400);
  });

  it("should handle custom response headers", async () => {
    const app = createApp();
    app.get("/headers", (_req, reply) => reply.header("x-custom", "value").json({ ok: true }));

    const response = await handle(app, "/headers");
    expect(response.headers.get("x-custom")).toBe("value");
  });

  it("should handle error responses", async () => {
    const app = createApp();
    app.get("/error", () => {
      throw new Error("boom");
    });

    const response = await handle(app, "/error");
    expect(response.status).toBe(500);
  });

  it("should handle CORS with plugin", async () => {
    const app = createApp();
    await app.register(cors({ origin: "*" }));
    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    const response = await handle(app, "/api", {
      headers: { origin: "http://example.com" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("should handle CORS preflight (OPTIONS)", async () => {
    const app = createApp();
    await app.register(cors({ origin: "*" }));
    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    const response = await handle(app, "/api", {
      method: "OPTIONS",
      headers: { origin: "http://example.com", "access-control-request-method": "GET" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBeTruthy();
  });

  it("should URL-decode path params", async () => {
    const app = createApp();
    app.get("/files/:name", (req, reply) => reply.json({ name: req.params.name }));

    const response = await handle(app, "/files/hello%20world");
    expect(await response.json()).toEqual({ name: "hello world" });
  });

  it("should support duplicate query params as arrays", async () => {
    const app = createApp();
    app.get("/search", (req, reply) => reply.json({ tags: req.query.tag }));

    const response = await handle(app, "/search?tag=a&tag=b");
    expect(await response.json()).toEqual({ tags: ["a", "b"] });
  });
});

describe("@celsian/adapter-vercel (Cron Handler)", () => {
  function makeCronRequest(path: string, secret?: string): Request {
    const headers: Record<string, string> = {};
    if (secret) {
      headers.authorization = `Bearer ${secret}`;
    }
    return new Request(`http://localhost${path}`, { headers });
  }

  it("should create a cron handler", () => {
    const app = createApp();
    const handler = createVercelCronHandler(app);
    expect(typeof handler).toBe("function");
  });

  it("should reject requests without valid CRON_SECRET", async () => {
    const app = createApp();
    app.get("/api/cron", (_req, reply) => reply.json({ ok: true }));

    const handler = createVercelCronHandler(app, "test-secret-123");

    // No auth header
    const res1 = await handler(makeCronRequest("/api/cron"));
    expect(res1.status).toBe(401);

    // Wrong secret
    const res2 = await handler(makeCronRequest("/api/cron", "wrong-secret"));
    expect(res2.status).toBe(401);
  });

  it("should allow requests with valid CRON_SECRET", async () => {
    // This used to register a normal route and assert its body came back,
    // which is exactly the defect: the handler ran the ROUTER, not the cron
    // jobs, so a correctly-configured Vercel cron got a 404 and no scheduled
    // work ever executed. It now reports which jobs it ran.
    const app = createApp();
    app.cron("cleanup", "0 3 * * *", async () => {});

    const handler = createVercelCronHandler(app, "test-secret-123");
    const response = await handler(makeCronRequest("/api/cron", "test-secret-123"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: ["cleanup"], failed: [] });
  });

  it("actually runs the registered cron jobs", async () => {
    const app = createApp();
    const calls: string[] = [];
    app.cron("nightly", "0 3 * * *", async () => {
      calls.push("nightly");
    });
    app.cron("hourly", "0 * * * *", async () => {
      calls.push("hourly");
    });

    const handler = createVercelCronHandler(app, "s");
    const res = await handler(makeCronRequest("/api/cron", "s"));

    expect(res.status).toBe(200);
    expect(calls.sort()).toEqual(["hourly", "nightly"]);
  });

  it("runs only the job whose schedule matches the bound expression", async () => {
    const app = createApp();
    const calls: string[] = [];
    app.cron("nightly", "0 3 * * *", async () => {
      calls.push("nightly");
    });
    app.cron("hourly", "0 * * * *", async () => {
      calls.push("hourly");
    });

    const handler = createVercelCronHandler(app, "s", { schedule: "0 3 * * *" });
    const res = await handler(makeCronRequest("/api/cron", "s"));

    expect(await res.json()).toEqual({ ran: ["nightly"], failed: [] });
    expect(calls).toEqual(["nightly"]);
  });

  it("lets a ?schedule= query parameter select the job", async () => {
    const app = createApp();
    const calls: string[] = [];
    app.cron("hourly", "0 * * * *", async () => {
      calls.push("hourly");
    });
    app.cron("nightly", "0 3 * * *", async () => {
      calls.push("nightly");
    });

    const handler = createVercelCronHandler(app, "s", { schedule: "0 3 * * *" });
    const res = await handler(makeCronRequest("/api/cron?schedule=0+*+*+*+*", "s"));

    expect(await res.json()).toEqual({ ran: ["hourly"], failed: [] });
    expect(calls).toEqual(["hourly"]);
  });

  it("reports a failing job as a 500 so Vercel marks the invocation failed", async () => {
    const app = createApp();
    app.cron("ok-job", "0 3 * * *", async () => {});
    app.cron("bad-job", "0 3 * * *", async () => {
      throw new Error("boom");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createVercelCronHandler(app, "s");
    const res = await handler(makeCronRequest("/api/cron", "s"));
    errorSpy.mockRestore();

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ran: ["ok-job"], failed: ["bad-job"] });
  });

  it("captures a synchronously-throwing job handler too", async () => {
    const app = createApp();
    app.cron("sync-throw", "0 3 * * *", () => {
      throw new Error("sync boom");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createVercelCronHandler(app, "s");
    const res = await handler(makeCronRequest("/api/cron", "s"));
    errorSpy.mockRestore();

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ failed: ["sync-throw"] });
  });

  it("warns and falls through to the router when no cron jobs are registered", async () => {
    // Back-compat: a plain route behind the CRON_SECRET check is a legitimate
    // setup, so it keeps working. The warning names the thing that is missing.
    const app = createApp();
    app.get("/api/cron", (_req, reply) => reply.json({ ok: true }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const handler = createVercelCronHandler(app, "s");
    const res = await handler(makeCronRequest("/api/cron", "s"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(warnSpy.mock.calls[0]?.[0]).toContain("no cron jobs are registered");
    warnSpy.mockRestore();
  });

  it("should reject with 503 when no secret configured (fail closed)", async () => {
    const app = createApp();
    app.cron("noop", "0 3 * * *", async () => {});

    // No secret parameter, and CRON_SECRET env not set
    const originalEnv = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;

    const handler = createVercelCronHandler(app);
    const response = await handler(makeCronRequest("/api/cron"));

    expect(response.status).toBe(503);

    // Restore env
    if (originalEnv !== undefined) {
      process.env.CRON_SECRET = originalEnv;
    }
  });

  it("should read CRON_SECRET from environment variable", async () => {
    const app = createApp();
    app.cron("noop", "0 3 * * *", async () => {});

    const originalEnv = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "env-secret-456";

    const handler = createVercelCronHandler(app);

    // Wrong secret
    const res1 = await handler(makeCronRequest("/api/cron", "wrong"));
    expect(res1.status).toBe(401);

    // Correct secret from env
    const res2 = await handler(makeCronRequest("/api/cron", "env-secret-456"));
    expect(res2.status).toBe(200);

    // Restore env
    if (originalEnv !== undefined) {
      process.env.CRON_SECRET = originalEnv;
    } else {
      delete process.env.CRON_SECRET;
    }
  });
});

describe("@celsian/adapter-vercel (Edge bundling smoke)", () => {
  // ADP-04: a module-level `import ... from "node:crypto"` breaks edge bundlers.
  // Bundle an entry that imports only createVercelEdgeHandler at platform=neutral
  // and assert the edge path carries no static top-level node: imports at all.
  const smokeDir = mkdtempSync(join(tmpdir(), "celsian-edge-smoke-"));

  afterAll(() => {
    rmSync(smokeDir, { recursive: true, force: true });
  });

  it("should bundle createVercelEdgeHandler at platform=neutral without static node: imports", async () => {
    const adapterSrc = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const entry = join(smokeDir, "entry.ts");
    writeFileSync(
      entry,
      `import { createVercelEdgeHandler } from ${JSON.stringify(adapterSrc)};\nexport default createVercelEdgeHandler;\n`,
    );

    // node:* externals cover @celsian/core's *lazy* `await import("node:...")`
    // helpers (sendFile/serve -- never executed on the edge request path).
    // Static top-level node: imports would survive as `import` statements in
    // the output, which is exactly what we assert against below.
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "neutral",
      external: ["node:*"],
      write: false,
    });

    expect(result.errors).toHaveLength(0);
    const output = result.outputFiles[0]!.text;

    // No static top-level imports of node builtins in the bundled edge entry
    const staticNodeImport = /^\s*import\s[^\n]*["']node:/m;
    expect(output).not.toMatch(staticNodeImport);

    // node:crypto must be gone entirely (replaced by Web Crypto)
    expect(output).not.toContain("node:crypto");
    // Runs a real esbuild bundle, which does not reliably fit in the 5s default
    // on a loaded machine. Observed timing out under parallel load and passing
    // in isolation, so the budget is raised rather than the check dropped.
  }, 60_000);
});
