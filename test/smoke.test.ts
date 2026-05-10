// CelsianJS — Full smoke test: inject + real HTTP server
//
// Exercises the most important features end-to-end:
// routing, params, schema validation, JSX, file serving,
// security headers, CORS, compression, SSE, background tasks,
// and error handling.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../packages/core/src/app.js";
import { ValidationError } from "../packages/core/src/errors.js";
import { cors } from "../packages/core/src/plugins/cors.js";
import { compress } from "../packages/compress/src/index.js";
import { createSSEHub } from "../packages/core/src/sse.js";
import { h, renderToString, Fragment } from "../packages/core/src/jsx.js";
import { nodeToWebRequest, writeWebResponse } from "../packages/core/src/serve.js";

// ─── Shared Fixtures ───

const TMP_DIR = join(import.meta.dirname ?? ".", "__smoke_tmp__");

beforeAll(async () => {
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(join(TMP_DIR, "readme.txt"), "CelsianJS is a TypeScript-first web framework.");
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── Helpers ───

/** Mock body schema with Zod-like interface (safeParse / parse) */
function createEchoSchema() {
  return {
    safeParse(input: unknown) {
      const data = input as Record<string, unknown>;
      if (data && typeof data === "object" && typeof data.message === "string") {
        return { success: true as const, data };
      }
      return {
        success: false as const,
        error: {
          issues: [{ message: "message must be a string", path: ["message"] }],
        },
      };
    },
    parse(input: unknown) {
      return input;
    },
  };
}

/** Build the full smoke-test app used by both inject and real-server sections. */
function buildSmokeApp() {
  const app = createApp(); // security headers enabled by default

  // ─── Plugins ───
  app.register(cors({ origin: "*" }), { encapsulate: false });
  app.register(compress({ threshold: 64 }), { encapsulate: false }); // low threshold so tests can trigger it

  // ─── SSE Hub ───
  const hub = createSSEHub();

  // ─── Routes ───

  // 1. JSON health check
  app.get("/api/health", (_req, reply) => reply.json({ status: "ok" }));

  // 2. Schema-validated echo
  app.post(
    "/api/echo",
    { schema: { body: createEchoSchema() } },
    (req, reply) => reply.json({ echo: req.parsedBody }),
  );

  // 3. Parametric route
  app.get("/api/users/:id", (req, reply) => reply.json({ id: req.params.id }));

  // 4. JSX page
  app.get("/", (_req, reply) => {
    const page = h("html", null,
      h("head", null, h("title", null, "CelsianJS")),
      h("body", null,
        h("h1", null, "Welcome to CelsianJS"),
        h("p", null, "TypeScript-first web framework"),
      ),
    );
    return reply.html(renderToString(page));
  });

  // 5. File serving
  app.get("/api/readme", async (_req, reply) => {
    return reply.sendFile(join(TMP_DIR, "readme.txt"));
  });

  // 6. SSE subscribe
  app.get("/api/events", (req) => {
    const channel = hub.subscribe(req, { pingInterval: 0 });
    // Send an initial event and close so fetch() resolves in tests
    channel.send({ event: "connected", data: { ok: true } });
    channel.close();
    return channel.response;
  });

  // 7. SSE broadcast
  app.post("/api/events", (req, reply) => {
    hub.broadcast({ event: "message", data: req.parsedBody ?? {} });
    return reply.json({ subscribers: hub.size });
  });

  // 8. Error route
  app.get("/api/explode", () => {
    throw new Error("Intentional kaboom");
  });

  // 9. Large response for compression testing
  app.get("/api/large", (_req, reply) => {
    const payload = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` })) };
    return reply.json(payload);
  });

  // ─── onError Hook ───
  // Skip ValidationError so the framework's default 400 handler runs
  app.addHook("onError", (error, _req, reply) => {
    if (error instanceof ValidationError) return;
    return reply.status(503).json({
      error: error.message,
      code: "CUSTOM_ERROR",
      handled: true,
    });
  });

  // ─── Background Task ───
  const taskResults: string[] = [];

  app.task({
    name: "smoke-task",
    handler: async (input: unknown) => {
      const data = input as { value: string };
      taskResults.push(`done:${data.value}`);
    },
    retries: 0,
  });

  app.get("/api/task-results", (_req, reply) => {
    return reply.json({ results: taskResults });
  });

  app.post("/api/enqueue", async (req, reply) => {
    const jobId = await app.enqueue("smoke-task", req.parsedBody);
    return reply.json({ jobId });
  });

  return { app, hub, taskResults };
}

// ════════════════════════════════════════════════════════════════
// PART 1: inject() tests (no server, no port, fast)
// ════════════════════════════════════════════════════════════════

describe("Smoke: inject()", () => {
  const { app } = buildSmokeApp();

  // ─── Health / JSON ───

  it("GET /api/health → 200, JSON { status: ok }", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  // ─── Security Headers ───

  it("GET /api/health has security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-xss-protection")).toBe("0");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
  });

  // ─── CORS ───

  it("CORS headers present on responses (origin: *)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("CORS preflight returns 204", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/health",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  // ─── Schema Validation ───

  it("POST /api/echo with valid body → 200, echoed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/echo",
      payload: { message: "hello" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.echo).toEqual({ message: "hello" });
  });

  it("POST /api/echo with invalid body → 400, validation error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/echo",
      payload: { message: 123 },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.issues).toBeDefined();
  });

  // ─── Params ───

  it("GET /api/users/42 → 200, id is '42'", async () => {
    const res = await app.inject({ method: "GET", url: "/api/users/42" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42" });
  });

  // ─── JSX ───

  it("GET / → 200, text/html with JSX content", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>Welcome to CelsianJS</h1>");
    expect(html).toContain("<title>CelsianJS</title>");
  });

  // ─── File Serving ───

  it("GET /api/readme → 200, serves text file", async () => {
    const res = await app.inject({ method: "GET", url: "/api/readme" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("CelsianJS");
  });

  // ─── SSE ───

  it("GET /api/events → 200, text/event-stream", async () => {
    const res = await app.inject({ method: "GET", url: "/api/events" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  // ─── Error Handling / onError Hook ───

  it("GET /api/explode → onError hook fires, returns 503 with custom shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/explode" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Intentional kaboom");
    expect(body.code).toBe("CUSTOM_ERROR");
    expect(body.handled).toBe(true);
  });

  // ─── Compression ───

  it("GET /api/large with Accept-Encoding: gzip → compressed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/large",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toContain("accept-encoding");
  });

  it("GET /api/large without Accept-Encoding → no compression", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/large",
    });
    expect(res.status).toBe(200);
    // No content-encoding means uncompressed
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = await res.json();
    expect(body.items).toHaveLength(100);
  });

  // ─── 404 ───

  it("GET /nonexistent → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/nonexistent" });
    expect(res.status).toBe(404);
  });

  // ─── 405 ───

  it("DELETE /api/health → 405 (path exists, wrong method)", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/health" });
    expect(res.status).toBe(405);
  });
});

// ════════════════════════════════════════════════════════════════
// PART 2: Real HTTP server tests
// ════════════════════════════════════════════════════════════════

describe("Smoke: Real HTTP Server", () => {
  let server: Server;
  let port: number;
  const { app, taskResults } = buildSmokeApp();

  function url(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  beforeAll(async () => {
    // Start task worker for background task tests
    app.setTaskWorkerOptions({ pollInterval: 50 });
    await app.ready();
    app.startWorker();

    // Create a real HTTP server on a random port
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const webRequest = nodeToWebRequest(req, reqUrl);
      try {
        const response = await app.handle(webRequest);
        await writeWebResponse(res, response);
      } catch {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await app.stopWorker();
    server.close();
  });

  // ─── Basic Routes ───

  it("GET /api/health → 200 over HTTP", async () => {
    const res = await fetch(url("/api/health"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  it("GET /api/users/99 → 200, parametric route", async () => {
    const res = await fetch(url("/api/users/99"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("99");
  });

  it("POST /api/echo with valid body → 200", async () => {
    const res = await fetch(url("/api/echo"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "from fetch" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.echo).toEqual({ message: "from fetch" });
  });

  it("POST /api/echo with invalid body → 400", async () => {
    const res = await fetch(url("/api/echo"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: 42 }),
    });
    expect(res.status).toBe(400);
  });

  // ─── Security Headers ───

  it("security headers present over HTTP", async () => {
    const res = await fetch(url("/api/health"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });

  // ─── CORS ───

  it("CORS headers present over HTTP", async () => {
    const res = await fetch(url("/api/health"), {
      headers: { origin: "https://example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  // ─── JSX ───

  it("GET / → text/html with rendered JSX", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>Welcome to CelsianJS</h1>");
  });

  // ─── File Serving ───

  it("GET /api/readme → file content", async () => {
    const res = await fetch(url("/api/readme"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("CelsianJS");
  });

  // ─── SSE ───

  it("GET /api/events → event-stream with initial event", async () => {
    const res = await fetch(url("/api/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: connected");
    expect(text).toContain('"ok":true');
  });

  // ─── Error Handling ───

  it("GET /api/explode → 503 from onError hook", async () => {
    const res = await fetch(url("/api/explode"));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.code).toBe("CUSTOM_ERROR");
    expect(data.handled).toBe(true);
  });

  // ─── Compression ───

  it("compression active with Accept-Encoding header", async () => {
    const res = await fetch(url("/api/large"), {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    // Node fetch auto-decompresses, but the header should be present
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  // ─── Background Tasks ───

  it("enqueue and process a background task", async () => {
    const enqueueRes = await fetch(url("/api/enqueue"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "smoke-42" }),
    });
    expect(enqueueRes.status).toBe(200);
    const { jobId } = await enqueueRes.json();
    expect(jobId).toBeTruthy();

    // Wait for the task worker to process (pollInterval: 50ms)
    await new Promise((r) => setTimeout(r, 300));

    const resultsRes = await fetch(url("/api/task-results"));
    const { results } = await resultsRes.json();
    expect(results).toContain("done:smoke-42");
  });

  // ─── 404 ───

  it("404 for unknown routes", async () => {
    const res = await fetch(url("/no-such-route"));
    expect(res.status).toBe(404);
  });

  // ─── HEAD fallback ───

  it("HEAD /api/health → 200", async () => {
    const res = await fetch(url("/api/health"), { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  // ─── Concurrent Requests ───

  it("handles 20 concurrent requests without errors", async () => {
    const requests = Array.from({ length: 20 }, (_, i) =>
      fetch(url(`/api/users/${i}`)).then((r) => r.json()),
    );
    const results = await Promise.all(requests);
    for (let i = 0; i < 20; i++) {
      expect(results[i].id).toBe(String(i));
    }
  });
});
