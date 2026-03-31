import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { escapeHtml, openapi } from "../src/plugins/openapi.js";

describe("OpenAPI Plugin", () => {
  it("should generate spec with registered routes", async () => {
    const app = createApp();
    app.get("/users", (_req, reply) => reply.json([]));
    app.post("/users", (_req, reply) => reply.json({ id: 1 }));
    app.get("/users/:id", (_req, reply) => reply.json({ id: 1 }));
    await app.register(openapi());

    const response = await app.inject({ url: "/docs/openapi.json" });
    expect(response.status).toBe(200);

    const spec = await response.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("CelsianJS API");
    expect(spec.info.version).toBe("1.0.0");

    // Should have all three route paths
    expect(spec.paths["/users"]).toBeDefined();
    expect(spec.paths["/users/{id}"]).toBeDefined();

    // GET and POST on /users
    expect(spec.paths["/users"].get).toBeDefined();
    expect(spec.paths["/users"].post).toBeDefined();

    // GET on /users/:id -> /users/{id}
    expect(spec.paths["/users/{id}"].get).toBeDefined();
  });

  it("should include schema information for validated routes", async () => {
    const app = createApp();
    app.route({
      method: "POST",
      url: "/items",
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "number" },
          },
          required: ["name"],
        },
        querystring: {
          type: "object",
          properties: {
            format: { type: "string" },
          },
        },
        params: {
          type: "object",
          properties: {},
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "number" },
              name: { type: "string" },
            },
          },
          400: {
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
      handler(_req, reply) {
        return reply.json({ id: 1, name: "Test" });
      },
    });
    await app.register(openapi());

    const response = await app.inject({ url: "/docs/openapi.json" });
    const spec = await response.json();

    const postOp = spec.paths["/items"].post;

    // Request body schema
    expect(postOp.requestBody).toBeDefined();
    expect(postOp.requestBody.required).toBe(true);
    expect(postOp.requestBody.content["application/json"].schema.properties.name.type).toBe("string");
    expect(postOp.requestBody.content["application/json"].schema.properties.price.type).toBe("number");

    // Query parameters
    const queryParam = postOp.parameters?.find((p: Record<string, unknown>) => p.in === "query" && p.name === "format");
    expect(queryParam).toBeDefined();
    expect(queryParam.schema.type).toBe("string");

    // Response schemas
    expect(postOp.responses["200"].content["application/json"].schema.properties.id.type).toBe("number");
    expect(postOp.responses["400"].content["application/json"].schema.properties.error.type).toBe("string");
  });

  it("should serve JSON spec at /docs/openapi.json", async () => {
    const app = createApp();
    app.get("/ping", (_req, reply) => reply.json({ pong: true }));
    await app.register(openapi());

    const response = await app.inject({ url: "/docs/openapi.json" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const spec = await response.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/ping"]).toBeDefined();
    expect(spec.paths["/ping"].get).toBeDefined();
  });

  it("should serve HTML UI at /docs", async () => {
    const app = createApp();
    app.get("/hello", (_req, reply) => reply.json({ hello: "world" }));
    await app.register(openapi());

    const response = await app.inject({ url: "/docs" });
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("swagger-ui");
    expect(html).toContain("/docs/openapi.json");
    expect(html).toContain("CelsianJS API");
  });

  it("should use custom title/version", async () => {
    const app = createApp();
    app.get("/status", (_req, reply) => reply.json({ up: true }));
    await app.register(
      openapi({
        title: "My Custom API",
        version: "2.5.0",
        description: "A custom API description",
      }),
    );

    const response = await app.inject({ url: "/docs/openapi.json" });
    const spec = await response.json();

    expect(spec.info.title).toBe("My Custom API");
    expect(spec.info.version).toBe("2.5.0");
    expect(spec.info.description).toBe("A custom API description");

    // Also check the HTML page uses custom title
    const htmlResponse = await app.inject({ url: "/docs" });
    const html = await htmlResponse.text();
    expect(html).toContain("My Custom API");
  });

  it("should support custom paths for JSON and UI", async () => {
    const app = createApp();
    app.get("/api/test", (_req, reply) => reply.json({ ok: true }));
    await app.register(
      openapi({
        jsonPath: "/api-docs/spec.json",
        uiPath: "/api-docs",
      }),
    );

    const jsonResponse = await app.inject({ url: "/api-docs/spec.json" });
    expect(jsonResponse.status).toBe(200);
    const spec = await jsonResponse.json();
    expect(spec.paths["/api/test"]).toBeDefined();

    const uiResponse = await app.inject({ url: "/api-docs" });
    expect(uiResponse.status).toBe(200);
    const html = await uiResponse.text();
    expect(html).toContain("/api-docs/spec.json");
  });

  it("should include servers when provided", async () => {
    const app = createApp();
    app.get("/test", (_req, reply) => reply.json({}));
    await app.register(
      openapi({
        servers: [
          { url: "https://api.example.com", description: "Production" },
          { url: "http://localhost:3000", description: "Local" },
        ],
      }),
    );

    const response = await app.inject({ url: "/docs/openapi.json" });
    const spec = await response.json();

    expect(spec.servers).toHaveLength(2);
    expect(spec.servers[0].url).toBe("https://api.example.com");
    expect(spec.servers[0].description).toBe("Production");
    expect(spec.servers[1].url).toBe("http://localhost:3000");
  });

  it("should auto-detect path params from URL even without schema", async () => {
    const app = createApp();
    app.get("/projects/:projectId/tasks/:taskId", (_req, reply) => reply.json({}));
    await app.register(openapi());

    const response = await app.inject({ url: "/docs/openapi.json" });
    const spec = await response.json();

    const getOp = spec.paths["/projects/{projectId}/tasks/{taskId}"].get;
    expect(getOp.parameters).toHaveLength(2);

    const projectParam = getOp.parameters.find((p: Record<string, unknown>) => p.name === "projectId");
    expect(projectParam).toBeDefined();
    expect(projectParam.in).toBe("path");
    expect(projectParam.required).toBe(true);

    const taskParam = getOp.parameters.find((p: Record<string, unknown>) => p.name === "taskId");
    expect(taskParam).toBeDefined();
  });

  it("should not include the docs routes themselves in the spec", async () => {
    const app = createApp();
    app.get("/api/data", (_req, reply) => reply.json([]));
    await app.register(openapi());

    const response = await app.inject({ url: "/docs/openapi.json" });
    const spec = await response.json();

    // The /docs and /docs/openapi.json routes should be excluded
    expect(spec.paths["/docs"]).toBeUndefined();
    expect(spec.paths["/docs/openapi.json"]).toBeUndefined();
    // But the real route should exist
    expect(spec.paths["/api/data"]).toBeDefined();
  });

  it("should handle routes without any schema gracefully", async () => {
    const app = createApp();
    app.get("/simple", (_req, reply) => reply.json({ ok: true }));
    app.delete("/simple/:id", (_req, reply) => reply.json({ deleted: true }));
    await app.register(openapi());

    const response = await app.inject({ url: "/docs/openapi.json" });
    const spec = await response.json();

    // Routes without schemas should have at least a default 200 response
    expect(spec.paths["/simple"].get.responses["200"]).toBeDefined();
    expect(spec.paths["/simple/{id}"].delete.responses["200"]).toBeDefined();
  });

  it("should HTML-escape title to prevent XSS in Swagger UI", async () => {
    const xssTitle = '<script>alert("xss")</script>';
    const app = createApp();
    app.get("/test", (_req, reply) => reply.json({ ok: true }));
    await app.register(openapi({ title: xssTitle }));

    const response = await app.inject({ url: "/docs" });
    const html = await response.text();

    // The raw <script> tag must NOT appear in the output
    expect(html).not.toContain("<script>alert");
    // The escaped version must appear
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("should HTML-escape jsonPath to prevent XSS in Swagger UI", async () => {
    const xssPath = "'/></script><script>alert('xss')</script><script x='";
    const app = createApp();
    app.get("/test", (_req, reply) => reply.json({ ok: true }));
    await app.register(openapi({ jsonPath: xssPath }));

    const response = await app.inject({ url: "/docs" });
    const html = await response.text();

    // The raw <script> injection must NOT appear
    expect(html).not.toContain("<script>alert");
  });
});

describe("escapeHtml", () => {
  it("should escape all dangerous HTML characters", () => {
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  it("should escape a full XSS payload", () => {
    const input = '<script>alert("xss")</script>';
    const escaped = escapeHtml(input);
    expect(escaped).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(escaped).not.toContain("<script>");
  });

  it("should leave safe strings unchanged", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
    expect(escapeHtml("my-api-v2")).toBe("my-api-v2");
  });
});
