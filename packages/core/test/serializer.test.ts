import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { compileSerializer } from "../src/serializer.js";

describe("compileSerializer", () => {
  it("should compile from TypeBox/JSON Schema with properties", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        active: { type: "boolean" },
      },
      required: ["id", "name"],
    };

    const serialize = compileSerializer(schema);
    expect(serialize).not.toBeNull();

    const result = serialize!({ id: 1, name: "test", active: true });
    expect(JSON.parse(result)).toEqual({ id: 1, name: "test", active: true });
  });

  it("should match JSON.stringify output for simple objects", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        email: { type: "string" },
      },
    };

    const serialize = compileSerializer(schema);
    const data = { id: 42, name: "Alice", email: "alice@example.com" };

    expect(serialize!(data)).toBe(JSON.stringify(data));
  });

  it("should handle null values", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
      },
    };

    const serialize = compileSerializer(schema);
    const result = serialize!({ id: 1, name: null });
    expect(JSON.parse(result)).toEqual({ id: 1, name: null });
  });

  it("should skip undefined values (like JSON.stringify)", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        optional: { type: "string" },
      },
    };

    const serialize = compileSerializer(schema);
    const data = { id: 1, name: "test" };
    const result = serialize!(data);
    expect(JSON.parse(result)).toEqual({ id: 1, name: "test" });
  });

  it("should handle nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
          },
        },
        status: { type: "string" },
      },
    };

    const serialize = compileSerializer(schema);
    const data = { user: { id: 1, name: "Alice" }, status: "active" };
    expect(JSON.parse(serialize!(data))).toEqual(data);
  });

  it("should handle arrays via fallback", () => {
    const schema = {
      type: "object",
      properties: {
        items: { type: "array" },
        count: { type: "number" },
      },
    };

    const serialize = compileSerializer(schema);
    const data = { items: [1, 2, 3], count: 3 };
    expect(JSON.parse(serialize!(data))).toEqual(data);
  });

  it("should handle strings with special characters", () => {
    const schema = {
      type: "object",
      properties: {
        text: { type: "string" },
      },
    };

    const serialize = compileSerializer(schema);
    const data = { text: 'hello "world"\nnewline\ttab\\backslash' };
    expect(JSON.parse(serialize!(data))).toEqual(data);
  });

  it("should return null for schemas without properties", () => {
    expect(compileSerializer(null)).toBeNull();
    expect(compileSerializer(undefined)).toBeNull();
    expect(compileSerializer({ type: "string" })).toBeNull();
    expect(compileSerializer({})).toBeNull();
  });

  it("should handle null input data", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "number" } },
    };

    const serialize = compileSerializer(schema);
    expect(serialize!(null)).toBe("null");
    expect(serialize!(undefined)).toBe("null");
  });
});

describe("Response schema pre-compilation integration", () => {
  it("should use pre-compiled serializer when schema.response is defined", async () => {
    const app = createApp();

    app.route({
      method: "GET",
      url: "/users",
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "number" },
              name: { type: "string" },
              email: { type: "string" },
            },
          },
        },
      },
      handler: (_req, reply) => reply.json({ id: 1, name: "Alice", email: "alice@test.com" }),
    });

    const response = await app.handle(new Request("http://localhost/users"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ id: 1, name: "Alice", email: "alice@test.com" });
  });

  it("should produce identical output to JSON.stringify", async () => {
    const app = createApp();
    const data = {
      id: 42,
      title: "Hello World",
      published: true,
      tags: ["a", "b"],
      meta: { views: 100 },
    };

    app.route({
      method: "GET",
      url: "/with-schema",
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "number" },
              title: { type: "string" },
              published: { type: "boolean" },
              tags: { type: "array" },
              meta: {
                type: "object",
                properties: {
                  views: { type: "number" },
                },
              },
            },
          },
        },
      },
      handler: (_req, reply) => reply.json(data),
    });

    app.get("/without-schema", (_req, reply) => reply.json(data));

    const [withSchema, withoutSchema] = await Promise.all([
      app.handle(new Request("http://localhost/with-schema")),
      app.handle(new Request("http://localhost/without-schema")),
    ]);

    const bodyWith = await withSchema.json();
    const bodyWithout = await withoutSchema.json();

    expect(bodyWith).toEqual(bodyWithout);
  });

  it("should fall back to JSON.stringify when no response schema", async () => {
    const app = createApp();

    app.get("/plain", (_req, reply) => reply.json({ hello: "world" }));

    const response = await app.handle(new Request("http://localhost/plain"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ hello: "world" });
  });

  it("should handle send() with pre-compiled serializer", async () => {
    const app = createApp();

    app.route({
      method: "GET",
      url: "/send-test",
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              count: { type: "number" },
            },
          },
        },
      },
      handler: (_req, reply) => reply.send({ status: "ok", count: 5 }),
    });

    const response = await app.handle(new Request("http://localhost/send-test"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok", count: 5 });
  });

  it("should work with schema.response using non-200 status codes", async () => {
    const app = createApp();

    app.route({
      method: "POST",
      url: "/create",
      schema: {
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "number" },
              created: { type: "boolean" },
            },
          },
        },
      },
      handler: (_req, reply) => reply.status(201).json({ id: 99, created: true }),
    });

    const response = await app.handle(
      new Request("http://localhost/create", { method: "POST" }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ id: 99, created: true });
  });

  it("should store serializer on the route", () => {
    const app = createApp();

    app.route({
      method: "GET",
      url: "/schema-route",
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "number" },
            },
          },
        },
      },
      handler: (_req, reply) => reply.json({ id: 1 }),
    });

    const routes = app.getRoutes();
    const route = routes.find((r) => r.url === "/schema-route");
    expect(route).toBeDefined();
    expect(route!.serializer).toBeTypeOf("function");
  });

  it("should not store serializer when no response schema", () => {
    const app = createApp();

    app.get("/no-schema", (_req, reply) => reply.json({ id: 1 }));

    const routes = app.getRoutes();
    const route = routes.find((r) => r.url === "/no-schema");
    expect(route).toBeDefined();
    expect(route!.serializer).toBeNull();
  });
});
