// @celsian/core -- Real HTTP integration tests (actual server + network requests)

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { HttpError } from "../src/errors.js";
import { serve } from "../src/serve.js";

/**
 * Helper: find a free port and start a Celsian server on it.
 * Uses the onReady callback to signal when the server is listening.
 */
async function launchApp(app: ReturnType<typeof createApp>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  // Find a free port by briefly binding and releasing
  const freePort = await new Promise<number>((resolve, reject) => {
    const tmp = createServer();
    tmp.listen(0, "127.0.0.1", () => {
      const addr = tmp.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        tmp.close(() => resolve(port));
      } else {
        reject(new Error("Failed to get port"));
      }
    });
  });

  const readyPromise = new Promise<void>((resolve) => {
    const check = setInterval(() => {
      // Try to connect
      fetch(`http://127.0.0.1:${freePort}/`)
        .then(() => {
          clearInterval(check);
          resolve();
        })
        .catch(() => {});
    }, 10);
  });

  const result = await serve(app, {
    port: freePort,
    host: "127.0.0.1",
  });

  // Wait for server to be ready
  await readyPromise;

  return {
    baseUrl: `http://127.0.0.1:${freePort}`,
    close: result.close,
  };
}

describe("HTTP Integration Tests", { timeout: 30_000 }, () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const app = createApp({ logger: false });

    // Register security plugin for header tests
    const { security } = await import("../src/plugins/security.js");
    app.register(security());

    // GET returning JSON
    app.get("/json", () => ({ message: "hello", timestamp: 123 }));

    // POST with JSON body (parsedBody is auto-populated by the framework)
    app.post("/echo", async (req) => {
      return { received: req.parsedBody };
    });

    // Error route
    app.get("/error", () => {
      throw new HttpError(422, "Validation failed", { code: "INVALID_INPUT" });
    });

    // Streaming response
    app.get("/stream", (_req, reply) => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("chunk1\n"));
          controller.enqueue(encoder.encode("chunk2\n"));
          controller.enqueue(encoder.encode("chunk3\n"));
          controller.close();
        },
      });
      reply.header("content-type", "text/plain");
      return reply.stream(stream);
    });

    // Cookie set route
    app.get("/set-cookie", (_req, reply) => {
      reply.cookie("session", "abc123", { httpOnly: true, path: "/" });
      return reply.json({ ok: true });
    });

    // Cookie read route
    app.get("/read-cookie", (req) => {
      return { session: req.cookies.session ?? null };
    });

    // Slow route for concurrency test
    app.get("/slow", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { slow: true };
    });

    const launched = await launchApp(app);
    baseUrl = launched.baseUrl;
    close = launched.close;
  });

  afterAll(async () => {
    await close();
  });

  // ─── GET returning JSON ───

  it("should return JSON from a GET request", async () => {
    const res = await fetch(`${baseUrl}/json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({ message: "hello", timestamp: 123 });
  });

  // ─── POST with JSON body ───

  it("should accept and echo a JSON POST body", async () => {
    const payload = { name: "Celsian", version: 1 };
    const res = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ received: payload });
  });

  // ─── 404 handling ───

  it("should return 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.statusCode).toBe(404);
  });

  // ─── Error response ───

  it("should return structured error for thrown HttpError", async () => {
    const res = await fetch(`${baseUrl}/error`);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.statusCode).toBe(422);
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.error).toBe("Validation failed");
  });

  // ─── Security headers ───

  it("should include security headers on real responses", async () => {
    const res = await fetch(`${baseUrl}/json`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-xss-protection")).toBe("0");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });

  // ─── Multiple concurrent requests ───

  it("should handle multiple concurrent requests", async () => {
    const requests = Array.from({ length: 20 }, (_, _i) =>
      fetch(`${baseUrl}/json`).then(async (res) => ({
        status: res.status,
        body: await res.json(),
      })),
    );

    const results = await Promise.all(requests);
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body.message).toBe("hello");
    }
  });

  // ─── Streaming response ───

  it("should deliver streaming response in chunks", async () => {
    const res = await fetch(`${baseUrl}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const text = await res.text();
    expect(text).toContain("chunk1");
    expect(text).toContain("chunk2");
    expect(text).toContain("chunk3");
  });

  // ─── Cookie round-trip ───

  it("should set and read cookies across requests", async () => {
    // First request: set the cookie
    const setRes = await fetch(`${baseUrl}/set-cookie`);
    expect(setRes.status).toBe(200);

    const setCookieHeader = setRes.headers.get("set-cookie");
    expect(setCookieHeader).toBeTruthy();
    expect(setCookieHeader).toContain("session=abc123");

    // Extract the cookie value to send in the next request
    if (!setCookieHeader) throw new Error("expected a set-cookie header");
    const cookieValue = setCookieHeader.split(";")[0] ?? ""; // "session=abc123"

    // Second request: send the cookie back
    const readRes = await fetch(`${baseUrl}/read-cookie`, {
      headers: { cookie: cookieValue },
    });
    expect(readRes.status).toBe(200);
    const body = await readRes.json();
    expect(body.session).toBe("abc123");
  });

  // ─── Concurrent mixed requests ───

  it("should handle concurrent requests to different routes", async () => {
    const requests = [
      fetch(`${baseUrl}/json`),
      fetch(`${baseUrl}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 1 }),
      }),
      fetch(`${baseUrl}/nonexistent`),
      fetch(`${baseUrl}/error`),
      fetch(`${baseUrl}/slow`),
    ];

    const [jsonRes, echoRes, notFoundRes, errorRes, slowRes] = await Promise.all(requests);

    expect(jsonRes.status).toBe(200);
    expect(echoRes.status).toBe(200);
    expect(notFoundRes.status).toBe(404);
    expect(errorRes.status).toBe(422);
    expect(slowRes.status).toBe(200);

    const slowBody = await slowRes.json();
    expect(slowBody.slow).toBe(true);
  });
});
