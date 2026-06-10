import { cors, createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import {
  type ALBEvent,
  type APIGatewayProxyEventV1,
  type APIGatewayProxyEventV2,
  type APIGatewayProxyResultV1,
  createLambdaHandler,
} from "../src/index.js";

function createEvent(overrides: Partial<APIGatewayProxyEventV2> & { method?: string } = {}): APIGatewayProxyEventV2 {
  const method = overrides.method ?? overrides.requestContext?.http?.method ?? "GET";
  const path = overrides.rawPath ?? "/hello";
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: overrides.rawQueryString ?? "",
    cookies: overrides.cookies,
    headers: overrides.headers ?? { host: "api.example.com" },
    body: overrides.body,
    isBase64Encoded: overrides.isBase64Encoded ?? false,
    requestContext: overrides.requestContext ?? {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "test-request-id",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
  };
}

describe("@celsian/adapter-lambda", () => {
  it("should create a Lambda handler", () => {
    const app = createApp();
    const handler = createLambdaHandler(app);
    expect(typeof handler).toBe("function");
  });

  it("should handle GET requests", async () => {
    const app = createApp();
    app.get("/hello", (_req, reply) => reply.json({ message: "hello" }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ message: "hello" });
  });

  it("should parse URL params", async () => {
    const app = createApp();
    app.get("/users/:id", (req, reply) => reply.json({ id: req.params.id }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({ rawPath: "/users/42" }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ id: "42" });
  });

  it("should handle POST with JSON body", async () => {
    const app = createApp();
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createEvent({
        rawPath: "/data",
        method: "POST",
        headers: { host: "api.example.com", "content-type": "application/json" },
        body: JSON.stringify({ name: "test" }),
        requestContext: {
          http: { method: "POST", path: "/data", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
          requestId: "test-2",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ received: { name: "test" } });
  });

  it("should return 404 for unmatched routes", async () => {
    const app = createApp();
    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({ rawPath: "/nope" }));
    expect(result.statusCode).toBe(404);
  });

  it("should return 405 for wrong method", async () => {
    const app = createApp();
    app.get("/only-get", (_req, reply) => reply.json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createEvent({
        rawPath: "/only-get",
        method: "POST",
        requestContext: {
          http: { method: "POST", path: "/only-get", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
          requestId: "test-405",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      }),
    );
    expect(result.statusCode).toBe(405);
  });

  it("should handle HEAD requests (fallback to GET)", async () => {
    const app = createApp();
    app.get("/hello", (_req, reply) => reply.json({ message: "hello" }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createEvent({
        method: "HEAD",
        requestContext: {
          http: { method: "HEAD", path: "/hello", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
          requestId: "test-head",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      }),
    );
    expect(result.statusCode).toBe(200);
  });

  it("should include response headers", async () => {
    const app = createApp();
    app.get("/hello", (_req, reply) => reply.header("x-custom", "value").json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent());
    expect(result.headers?.["x-custom"]).toBe("value");
  });

  it("should handle base64 encoded body", async () => {
    const app = createApp();
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody }));

    const handler = createLambdaHandler(app);
    const body = JSON.stringify({ encoded: true });
    const result = await handler(
      createEvent({
        rawPath: "/data",
        method: "POST",
        headers: { host: "api.example.com", "content-type": "application/json" },
        body: Buffer.from(body).toString("base64"),
        isBase64Encoded: true,
        requestContext: {
          http: { method: "POST", path: "/data", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
          requestId: "test-3",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ received: { encoded: true } });
  });

  it("should handle query string parameters", async () => {
    const app = createApp();
    app.get("/search", (req, reply) => reply.json({ q: req.query.q }));

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({ rawPath: "/search", rawQueryString: "q=hello" }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ q: "hello" });
  });

  it("should reject oversized body", async () => {
    const app = createApp({ bodyLimit: 100 });
    app.post("/data", (_req, reply) => reply.json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createEvent({
        rawPath: "/data",
        method: "POST",
        headers: { host: "api.example.com", "content-type": "application/json", "content-length": "1000000" },
        body: JSON.stringify({ big: "x".repeat(1000) }),
        requestContext: {
          http: { method: "POST", path: "/data", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
          requestId: "test-413",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      }),
    );
    expect(result.statusCode).toBe(413);
  });

  it("should return 400 for malformed JSON", async () => {
    const app = createApp();
    app.post("/data", (_req, reply) => reply.json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createEvent({
        rawPath: "/data",
        method: "POST",
        headers: { host: "api.example.com", "content-type": "application/json" },
        body: "{broken json",
        requestContext: {
          http: { method: "POST", path: "/data", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
          requestId: "test-400",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      }),
    );
    expect(result.statusCode).toBe(400);
  });

  it("should handle error responses", async () => {
    const app = createApp();
    app.get("/error", () => {
      throw new Error("boom");
    });

    const handler = createLambdaHandler(app);
    const result = await handler(createEvent({ rawPath: "/error" }));
    expect(result.statusCode).toBe(500);
  });

  it("should handle CORS with plugin", async () => {
    const app = createApp();
    await app.register(cors({ origin: "*" }));
    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createEvent({
        rawPath: "/api",
        headers: { host: "api.example.com", origin: "http://example.com" },
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers?.["access-control-allow-origin"]).toBe("*");
  });

  it("should handle CORS preflight (OPTIONS)", async () => {
    const app = createApp();
    await app.register(cors({ origin: "*" }));
    app.get("/api", (_req, reply) => reply.json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createEvent({
        rawPath: "/api",
        method: "OPTIONS",
        headers: { host: "api.example.com", origin: "http://example.com", "access-control-request-method": "GET" },
        requestContext: {
          http: { method: "OPTIONS", path: "/api", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
          requestId: "test-preflight",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      }),
    );
    expect(result.statusCode).toBe(204);
    expect(result.headers?.["access-control-allow-origin"]).toBe("*");
    expect(result.headers?.["access-control-allow-methods"]).toBeTruthy();
  });

  it("should extract Set-Cookie to cookies array", async () => {
    const app = createApp();
    app.get("/cookie", (_req, reply) => {
      return reply.cookie("session", "abc123", { httpOnly: true }).json({ ok: true });
    });

    const handler = createLambdaHandler(app);
    const result = (await handler(createEvent({ rawPath: "/cookie" }))) as { cookies?: string[]; statusCode: number };
    expect(result.statusCode).toBe(200);
    expect(result.cookies).toBeDefined();
    expect(result.cookies?.length).toBeGreaterThan(0);
    expect(result.cookies?.[0]).toContain("session=abc123");
  });

  // ADP-01: APIGW v2 delivers request cookies in event.cookies, not headers
  it("should expose v2 event.cookies array as the cookie header", async () => {
    const app = createApp();
    app.get("/whoami", (req, reply) => reply.json({ cookie: req.headers.get("cookie") }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createEvent({
        rawPath: "/whoami",
        cookies: ["session=abc123", "theme=dark"],
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ cookie: "session=abc123; theme=dark" });
  });

  // ADP-02: base64 bodies must not be round-tripped through utf-8
  it("should round-trip binary base64 bodies byte-exact (PNG header)", async () => {
    // PNG magic bytes — 0x89 is invalid utf-8 and corrupts to U+FFFD if decoded
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);

    const app = createApp();
    app.post("/upload", async (req) => {
      const bytes = new Uint8Array(await req.arrayBuffer());
      return new Response(bytes, { headers: { "content-type": "image/png" } });
    });

    const handler = createLambdaHandler(app);
    const result = await handler(
      createEvent({
        rawPath: "/upload",
        method: "POST",
        headers: { host: "api.example.com", "content-type": "image/png" },
        body: pngHeader.toString("base64"),
        isBase64Encoded: true,
        requestContext: {
          http: { method: "POST", path: "/upload", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
          requestId: "test-binary",
          time: new Date().toISOString(),
          timeEpoch: Date.now(),
        },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(true);
    const roundTripped = Buffer.from(result.body!, "base64");
    expect(roundTripped.equals(pngHeader)).toBe(true);
  });
});

describe("@celsian/adapter-lambda (API Gateway v1 / REST)", () => {
  function createV1Event(overrides: Partial<APIGatewayProxyEventV1> = {}): APIGatewayProxyEventV1 {
    return {
      httpMethod: "GET",
      path: "/hello",
      headers: { host: "api.example.com" },
      multiValueHeaders: null,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      body: null,
      isBase64Encoded: false,
      requestContext: {
        requestId: "v1-request-id",
        identity: { sourceIp: "127.0.0.1", userAgent: "test" },
      },
      ...overrides,
    };
  }

  it("should handle a v1 GET request (no requestContext.http)", async () => {
    const app = createApp();
    app.get("/hello", (_req, reply) => reply.json({ message: "hello" }));

    const handler = createLambdaHandler(app);
    const result = await handler(createV1Event());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ message: "hello" });
  });

  it("should handle v1 POST with body and query params", async () => {
    const app = createApp();
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody, q: req.query.q }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createV1Event({
        httpMethod: "POST",
        path: "/data",
        headers: { host: "api.example.com", "content-type": "application/json" },
        queryStringParameters: { q: "hello" },
        body: JSON.stringify({ name: "v1" }),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ received: { name: "v1" }, q: "hello" });
  });

  it("should merge multiValueHeaders and multiValueQueryStringParameters", async () => {
    const app = createApp();
    app.get("/multi", (req, reply) => reply.json({ accept: req.headers.get("accept"), tags: req.query.tag }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createV1Event({
        path: "/multi",
        headers: null,
        multiValueHeaders: {
          host: ["api.example.com"],
          accept: ["text/html", "application/json"],
        },
        multiValueQueryStringParameters: { tag: ["a", "b"] },
      }),
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body.accept).toBe("text/html, application/json");
    expect(body.tags).toEqual(["a", "b"]);
  });

  it("should return set-cookie via multiValueHeaders for v1", async () => {
    const app = createApp();
    app.get("/cookie", (_req, reply) => reply.cookie("session", "v1cookie", { httpOnly: true }).json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = (await handler(createV1Event({ path: "/cookie" }))) as APIGatewayProxyResultV1;

    expect(result.statusCode).toBe(200);
    expect(result.multiValueHeaders?.["set-cookie"]).toBeDefined();
    expect(result.multiValueHeaders?.["set-cookie"]?.[0]).toContain("session=v1cookie");
    // v1/ALB results must not use the v2 cookies array
    expect((result as { cookies?: string[] }).cookies).toBeUndefined();
  });

  it("should decode v1 base64 bodies byte-exact", async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const app = createApp();
    app.post("/upload", async (req) => {
      const bytes = new Uint8Array(await req.arrayBuffer());
      return new Response(bytes, { headers: { "content-type": "image/png" } });
    });

    const handler = createLambdaHandler(app);
    const result = await handler(
      createV1Event({
        httpMethod: "POST",
        path: "/upload",
        headers: { host: "api.example.com", "content-type": "image/png" },
        body: pngHeader.toString("base64"),
        isBase64Encoded: true,
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(Buffer.from(result.body!, "base64").equals(pngHeader)).toBe(true);
  });
});

describe("@celsian/adapter-lambda (ALB)", () => {
  function createALBEvent(overrides: Partial<ALBEvent> = {}): ALBEvent {
    return {
      httpMethod: "GET",
      path: "/hello",
      headers: { host: "alb.example.com" },
      queryStringParameters: {},
      body: "",
      isBase64Encoded: false,
      requestContext: {
        elb: { targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/test/abc" },
      },
      ...overrides,
    };
  }

  it("should handle an ALB GET request", async () => {
    const app = createApp();
    app.get("/hello", (_req, reply) => reply.json({ message: "alb" }));

    const handler = createLambdaHandler(app);
    const result = await handler(createALBEvent());

    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(false);
    expect(JSON.parse(result.body!)).toEqual({ message: "alb" });
  });

  it("should handle ALB POST with JSON body", async () => {
    const app = createApp();
    app.post("/data", (req, reply) => reply.json({ received: req.parsedBody }));

    const handler = createLambdaHandler(app);
    const result = await handler(
      createALBEvent({
        httpMethod: "POST",
        path: "/data",
        headers: { host: "alb.example.com", "content-type": "application/json" },
        body: JSON.stringify({ name: "alb" }),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ received: { name: "alb" } });
  });

  it("should put set-cookie in plain headers for single-value ALB events", async () => {
    const app = createApp();
    app.get("/cookie", (_req, reply) => reply.cookie("session", "albcookie").json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = (await handler(createALBEvent({ path: "/cookie" }))) as APIGatewayProxyResultV1;

    expect(result.statusCode).toBe(200);
    expect(result.headers?.["set-cookie"]).toContain("session=albcookie");
  });

  it("should put set-cookie in multiValueHeaders for multi-value ALB events", async () => {
    const app = createApp();
    app.get("/cookies", (_req, reply) => reply.cookie("a", "1").cookie("b", "2").json({ ok: true }));

    const handler = createLambdaHandler(app);
    const result = (await handler(
      createALBEvent({
        path: "/cookies",
        headers: undefined,
        multiValueHeaders: { host: ["alb.example.com"] },
      }),
    )) as APIGatewayProxyResultV1;

    expect(result.statusCode).toBe(200);
    const setCookies = result.multiValueHeaders?.["set-cookie"];
    expect(setCookies).toHaveLength(2);
    expect(setCookies?.[0]).toContain("a=1");
    expect(setCookies?.[1]).toContain("b=2");
  });
});
