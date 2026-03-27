// @celsian/adapter-node — E2E tests with real HTTP server

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResponseCache } from "../../cache/src/response-cache.js";
import { createSessionManager } from "../../cache/src/session.js";
import { MemoryKVStore } from "../../cache/src/store.js";
import { createApp } from "../../core/src/app.js";
import { cors } from "../../core/src/plugins/cors.js";
import { createSSEStream } from "../../core/src/sse.js";
import { nodeToWebRequest, writeWebResponse } from "../src/index.js";

let server: Server;
let port: number;

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

describe("E2E: Full Stack Integration", () => {
  beforeAll(async () => {
    const app = createApp();
    const kvStore = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const responseCache = createResponseCache({ store: kvStore, ttlMs: 5000 });
    const sessions = createSessionManager({ store: kvStore });
    const taskResults: string[] = [];

    // Register middleware
    await app.register(cors({ origin: "https://example.com", credentials: true }), { encapsulate: false });

    // Register task handler using core's built-in task system
    app.task({
      name: "process-data",
      handler: async (input: unknown) => {
        const payload = input as { id: string };
        taskResults.push(`processed:${payload.id}`);
      },
      retries: 0,
    });

    // Routes
    app.get("/api/health", (_req, reply) => reply.json({ status: "ok", uptime: process.uptime() }));

    app.get("/api/data", async (req, reply) => {
      return responseCache.cached(req, () => {
        return reply.json({ items: [1, 2, 3], timestamp: Date.now() });
      });
    });

    app.post("/api/echo", (req, reply) => {
      return reply.json({ method: req.method, body: req.parsedBody, query: req.query });
    });

    app.get("/api/users/:id", (req, reply) => {
      return reply.json({ userId: req.params.id, name: `User ${req.params.id}` });
    });

    app.post("/api/session", async (_req, reply) => {
      const session = await sessions.create({ user: "test-user" });
      await session.save();
      return reply.header("set-cookie", sessions.cookie(session.id)).json({ sessionId: session.id });
    });

    app.get("/api/session", async (req, reply) => {
      const session = await sessions.fromRequest(req);
      return reply.json({ data: session.all() });
    });

    app.post("/api/task", async (_req, reply) => {
      const jobId = await app.enqueue("process-data", { id: "test-123" });
      return reply.json({ jobId });
    });

    app.get("/api/task-results", (_req, reply) => {
      return reply.json({ results: taskResults });
    });

    app.get("/api/sse", (req, _reply) => {
      const channel = createSSEStream(req, { pingInterval: 0 });
      channel.send({ event: "greeting", data: { message: "hello" } });
      channel.send({ event: "update", data: { count: 42 } });
      channel.close();
      return channel.response;
    });

    app.get("/api/error", () => {
      throw new Error("Intentional error");
    });

    app.get("/api/redirect", (_req, reply) => {
      return reply.redirect("/api/health", 302);
    });

    app.get("/api/html", (_req, reply) => {
      return reply.html("<h1>Hello CelsianJS</h1>");
    });

    // Start task worker (core requires explicit start)
    app.setTaskWorkerOptions({ pollInterval: 50 });
    await app.ready();
    app.startWorker();

    // Create HTTP server
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const webRequest = nodeToWebRequest(req, reqUrl);
      try {
        const response = await app.handle(webRequest);
        await writeWebResponse(res, response);
      } catch (_error) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });

    // Find an available port
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    server.close();
  });

  // Allow `app` reference in tests (closure captures it from beforeAll)
  // Note: app is local to beforeAll but task/session tests work via HTTP.

  // ─── Basic Routes ───

  it("GET /api/health returns 200", async () => {
    const res = await fetch(url("/api/health"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.uptime).toBeGreaterThan(0);
  });

  it("GET with parametric route works", async () => {
    const res = await fetch(url("/api/users/42"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.userId).toBe("42");
    expect(data.name).toBe("User 42");
  });

  it("POST with JSON body is parsed", async () => {
    const res = await fetch(url("/api/echo?foo=bar"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.method).toBe("POST");
    expect(data.body).toEqual({ message: "hello" });
    expect(data.query.foo).toBe("bar");
  });

  it("404 for unknown routes", async () => {
    const res = await fetch(url("/api/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("HEAD returns 200 with no body", async () => {
    const res = await fetch(url("/api/health"), { method: "HEAD" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("");
  });

  // ─── CORS ───

  it("CORS headers are set for allowed origin", async () => {
    const res = await fetch(url("/api/health"), {
      headers: { origin: "https://example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("CORS preflight returns 204", async () => {
    const res = await fetch(url("/api/health"), {
      method: "OPTIONS",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("CORS headers not set for disallowed origin", async () => {
    const res = await fetch(url("/api/health"), {
      headers: { origin: "https://evil.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  // ─── Rate Limiting (removed with @celsian/server — now in @celsian/rate-limit) ───

  // ─── Response Cache ───

  it("response cache returns MISS then HIT", async () => {
    // Clear any previous cache by using unique endpoint
    const res1 = await fetch(url("/api/data"));
    expect(res1.status).toBe(200);
    expect(res1.headers.get("x-cache")).toBe("MISS");

    const res2 = await fetch(url("/api/data"));
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-cache")).toBe("HIT");

    // Cached data should be identical
    const d1 = await res1.json();
    const d2 = await res2.json();
    expect(d1.items).toEqual(d2.items);
  });

  // ─── Sessions ───

  it("creates and loads a session", async () => {
    // Create session
    const createRes = await fetch(url("/api/session"), { method: "POST" });
    expect(createRes.status).toBe(200);
    const cookie = createRes.headers.get("set-cookie");
    expect(cookie).toContain("sid=");

    const createData = await createRes.json();
    expect(createData.sessionId).toBeTruthy();

    // Load session with cookie
    const loadRes = await fetch(url("/api/session"), {
      headers: { cookie: cookie! },
    });
    expect(loadRes.status).toBe(200);
    const loadData = await loadRes.json();
    expect(loadData.data.user).toBe("test-user");
  });

  // ─── Task Queue ───

  it("enqueues and processes a background task", async () => {
    const enqueueRes = await fetch(url("/api/task"), { method: "POST" });
    expect(enqueueRes.status).toBe(200);
    const { jobId } = await enqueueRes.json();
    expect(jobId).toBeTruthy();

    // Wait for processing (pollInterval set to 50ms above)
    await new Promise((r) => setTimeout(r, 300));

    const resultsRes = await fetch(url("/api/task-results"));
    const { results } = await resultsRes.json();
    expect(results).toContain("processed:test-123");
  });

  // ─── SSE ───

  it("SSE endpoint returns event-stream", async () => {
    const res = await fetch(url("/api/sse"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: greeting");
    expect(text).toContain("event: update");
    expect(text).toContain('"count":42');
  });

  // ─── Error Handling ───

  it("error route returns 500 with JSON", async () => {
    const res = await fetch(url("/api/error"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Intentional error");
    expect(data.statusCode).toBe(500);
  });

  // ─── Redirect ───

  it("redirect returns 302 with location header", async () => {
    const res = await fetch(url("/api/redirect"), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/api/health");
  });

  // ─── HTML Response ───

  it("HTML route returns HTML content", async () => {
    const res = await fetch(url("/api/html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("<h1>Hello CelsianJS</h1>");
  });

  // ─── Concurrent Requests ───

  it("handles 50 concurrent requests correctly", async () => {
    const requests = Array.from({ length: 50 }, (_, i) => fetch(url(`/api/users/${i}`)).then((r) => r.json()));

    const results = await Promise.all(requests);

    for (let i = 0; i < 50; i++) {
      expect(results[i].userId).toBe(String(i));
    }
  });
});
