import { describe, expect, it } from "vitest";
import { corsHeaders, isOriginAllowed, preflightResponse } from "../src/cors.js";
import { applyRewrite, compileRoute, compileRoutes, matchRoute } from "../src/match.js";
import { createEdgeRouter, getProjectId } from "../src/router.js";
import type { CorsConfig, RouteEntry } from "../src/types.js";

// ── Match ───────────────────────────────────────────────────────
describe("compileRoute", () => {
  it("compiles a static pattern", () => {
    const entry: RouteEntry = { pattern: "/api/health", methods: ["GET"], origin: "http://localhost:3000" };
    const compiled = compileRoute(entry);
    expect(compiled.regex.test("/api/health")).toBe(true);
    expect(compiled.regex.test("/api/other")).toBe(false);
    expect(compiled.paramNames).toEqual([]);
    expect(compiled.methods.has("GET")).toBe(true);
  });

  it("compiles a pattern with params", () => {
    const entry: RouteEntry = { pattern: "/users/:id", methods: ["GET", "PUT"], origin: "http://localhost:3000" };
    const compiled = compileRoute(entry);
    const match = "/users/42".match(compiled.regex);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("42");
    expect(compiled.paramNames).toEqual(["id"]);
  });

  it("compiles a pattern with multiple params", () => {
    const entry: RouteEntry = {
      pattern: "/orgs/:orgId/repos/:repoId",
      methods: ["GET"],
      origin: "http://localhost:3000",
    };
    const compiled = compileRoute(entry);
    const match = "/orgs/acme/repos/widget".match(compiled.regex);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("acme");
    expect(match?.[2]).toBe("widget");
    expect(compiled.paramNames).toEqual(["orgId", "repoId"]);
  });

  it("compiles a wildcard pattern", () => {
    const entry: RouteEntry = { pattern: "/static/*", methods: ["GET"], origin: "http://cdn.example.com" };
    const compiled = compileRoute(entry);
    const match = "/static/css/main.css".match(compiled.regex);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("css/main.css");
  });
});

describe("matchRoute", () => {
  const entries: RouteEntry[] = [
    { pattern: "/api/users", methods: ["GET", "POST"], origin: "http://users-svc:3000" },
    { pattern: "/api/users/:id", methods: ["GET", "PUT", "DELETE"], origin: "http://users-svc:3000" },
    { pattern: "/api/posts", methods: ["GET"], origin: "http://posts-svc:3001" },
    { pattern: "/static/*", methods: ["GET"], origin: "http://cdn.example.com" },
  ];
  const routes = compileRoutes(entries);

  it("matches a static route", () => {
    const result = matchRoute(routes, "/api/users", "GET");
    expect(result).not.toBeNull();
    expect(result?.route.entry.pattern).toBe("/api/users");
    expect(result?.params).toEqual({});
  });

  it("matches a parameterized route", () => {
    const result = matchRoute(routes, "/api/users/42", "GET");
    expect(result).not.toBeNull();
    expect(result?.params).toEqual({ id: "42" });
  });

  it("rejects wrong method", () => {
    const result = matchRoute(routes, "/api/posts", "DELETE");
    expect(result).toBeNull();
  });

  it("returns null for no match", () => {
    const result = matchRoute(routes, "/api/unknown", "GET");
    expect(result).toBeNull();
  });

  it("matches a wildcard route", () => {
    const result = matchRoute(routes, "/static/img/logo.png", "GET");
    expect(result).not.toBeNull();
    expect(result?.route.entry.origin).toBe("http://cdn.example.com");
  });
});

describe("applyRewrite", () => {
  it("substitutes params in rewrite pattern", () => {
    const result = applyRewrite("/v2/users/:id/profile", { id: "42" });
    expect(result).toBe("/v2/users/42/profile");
  });

  it("handles multiple params", () => {
    const result = applyRewrite("/:org/:repo", { org: "acme", repo: "widget" });
    expect(result).toBe("/acme/widget");
  });

  it("returns pattern unchanged when no params match", () => {
    const result = applyRewrite("/static/path", {});
    expect(result).toBe("/static/path");
  });
});

// ── CORS ────────────────────────────────────────────────────────
describe("isOriginAllowed", () => {
  it("allows wildcard origin", () => {
    expect(isOriginAllowed("https://example.com", { origin: "*" })).toBe(true);
  });

  it("allows exact match", () => {
    expect(isOriginAllowed("https://app.com", { origin: "https://app.com" })).toBe(true);
    expect(isOriginAllowed("https://other.com", { origin: "https://app.com" })).toBe(false);
  });

  it("allows array of origins", () => {
    const config: CorsConfig = { origin: ["https://a.com", "https://b.com"] };
    expect(isOriginAllowed("https://a.com", config)).toBe(true);
    expect(isOriginAllowed("https://c.com", config)).toBe(false);
  });

  it("allows function-based origin", () => {
    const config: CorsConfig = { origin: (o) => o.endsWith(".example.com") };
    expect(isOriginAllowed("https://app.example.com", config)).toBe(true);
    expect(isOriginAllowed("https://evil.com", config)).toBe(false);
  });
});

describe("corsHeaders", () => {
  it("returns empty headers for disallowed origin", () => {
    const headers = corsHeaders("https://evil.com", { origin: "https://app.com" });
    expect(Object.keys(headers)).toHaveLength(0);
  });

  it("returns ACAO for allowed origin", () => {
    const headers = corsHeaders("https://app.com", { origin: "https://app.com" });
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.com");
  });

  it("returns * for wildcard origin", () => {
    const headers = corsHeaders("https://any.com", { origin: "*" });
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("includes credentials header when configured", () => {
    const headers = corsHeaders("https://app.com", { origin: "https://app.com", credentials: true });
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });
});

describe("preflightResponse", () => {
  it("returns 204 with CORS headers", () => {
    const config: CorsConfig = { origin: "*", methods: ["GET", "POST"], maxAge: 3600 };
    const res = preflightResponse("https://app.com", config);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("3600");
  });
});

// ── Router integration ──────────────────────────────────────────
describe("createEdgeRouter", () => {
  const router = createEdgeRouter({
    routes: [
      { pattern: "/api/users", methods: ["GET"], origin: "http://users-svc:3000" },
      { pattern: "/api/users/:id", methods: ["GET"], origin: "http://users-svc:3000" },
    ],
    cors: { origin: "*" },
  });

  it("responds to /__health", async () => {
    const req = new Request("https://edge.example.com/__health");
    const res = await router.fetch(req);
    const body = (await res.json()) as { ok: boolean; platform: string; routes: number };
    expect(body.ok).toBe(true);
    expect(body.platform).toBe("celsian");
    expect(body.routes).toBe(2);
  });

  it("responds to GET /__routes", async () => {
    const req = new Request("https://edge.example.com/__routes");
    const res = await router.fetch(req);
    const body = (await res.json()) as { routes: unknown[] };
    expect(body.routes).toHaveLength(2);
  });

  it("returns 404 for unmatched route", async () => {
    const req = new Request("https://edge.example.com/unknown");
    const res = await router.fetch(req);
    expect(res.status).toBe(404);
  });

  it("handles CORS preflight", async () => {
    const req = new Request("https://edge.example.com/api/users", {
      method: "OPTIONS",
      headers: { Origin: "https://app.com" },
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("updates routes via POST /__routes", async () => {
    const req = new Request("https://edge.example.com/__routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routes: [{ pattern: "/v2/health", methods: ["GET"], origin: "http://new-svc:4000" }],
      }),
    });
    const res = await router.fetch(req);
    const body = (await res.json()) as { success: boolean; routeCount: number };
    expect(body.success).toBe(true);
    expect(body.routeCount).toBe(1);

    // Verify the new route shows up
    const listReq = new Request("https://edge.example.com/__routes");
    const listRes = await router.fetch(listReq);
    const listBody = (await listRes.json()) as { routes: unknown[] };
    expect(listBody.routes).toHaveLength(1);
  });

  it("rejects invalid route update", async () => {
    const req = new Request("https://edge.example.com/__routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routes: [{ pattern: "/x" }] }),
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(400);
  });
});

// ── Preview URL parsing ──────────────────────────────────────────
describe("getProjectId", () => {
  it("parses production hostname", () => {
    expect(getProjectId("myapp.celsian.app")).toBe("myapp");
  });

  it("parses preview deployment hostname", () => {
    expect(getProjectId("feat-login--myapp.preview.celsian.app")).toBe("myapp:preview:feat-login");
  });

  it("returns null for unrecognized hostname", () => {
    expect(getProjectId("example.com")).toBeNull();
  });
});

// ── URL-decoded params ───────────────────────────────────────────
describe("matchRoute — URL-decoded params", () => {
  it("decodes URI-encoded param values", () => {
    const routes = compileRoutes([{ pattern: "/files/:name", methods: ["GET"], origin: "http://localhost:3000" }]);
    const result = matchRoute(routes, "/files/hello%20world", "GET");
    expect(result).not.toBeNull();
    expect(result?.params.name).toBe("hello world");
  });
});

// ── CORS credentials + wildcard ──────────────────────────────────
describe("corsHeaders — credentials + wildcard", () => {
  it("does NOT set credentials header when origin is wildcard", () => {
    const headers = corsHeaders("https://app.com", { origin: "*", credentials: true });
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("sets credentials header and Vary for specific origin", () => {
    const headers = corsHeaders("https://app.com", { origin: "https://app.com", credentials: true });
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.com");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(headers.Vary).toBe("Origin");
  });
});
