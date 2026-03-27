import { createApp } from "@celsian/core";
import { describe, expect, it } from "vitest";
import { compress } from "../src/index.js";

describe("@celsian/compress", () => {
  it("should register as plugin", async () => {
    const app = createApp();
    await app.register(compress(), { encapsulate: false });

    app.get("/test", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({ url: "/test" });
    expect(response.status).toBe(200);
  });

  it("should compress large responses with gzip", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 100 }), { encapsulate: false });

    const largeData = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` })) };
    app.get("/large", (_req, reply) => reply.json(largeData));

    const response = await app.inject({
      url: "/large",
      headers: { "accept-encoding": "gzip, deflate" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toContain("accept-encoding");
  });

  it("should not compress responses below threshold", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 1024 }), { encapsulate: false });

    app.get("/small", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      url: "/small",
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("should not compress when no Accept-Encoding", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });

    app.get("/test", (_req, reply) => reply.json({ message: "hello world" }));

    const response = await app.inject({ url: "/test" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("should accept custom encodings", async () => {
    const app = createApp();
    await app.register(compress({ encodings: ["deflate"], threshold: 10 }), { encapsulate: false });

    app.get("/test", (_req, reply) => reply.json({ message: "this is a longer response body" }));

    const response = await app.inject({
      url: "/test",
      headers: { "accept-encoding": "gzip, deflate" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("deflate");
  });

  it("should compress html responses", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });

    app.get("/page", (_req, reply) => reply.html("<html><body><h1>Hello World</h1></body></html>"));

    const response = await app.inject({
      url: "/page",
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("should compress send() string responses", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });

    app.get("/text", (_req, reply) => reply.send("This is a text response that should be compressed"));

    const response = await app.inject({
      url: "/text",
      headers: { "accept-encoding": "deflate" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("deflate");
  });

  it("should produce decompressible output", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });

    const data = { message: "hello compressed world", items: [1, 2, 3] };
    app.get("/verify", (_req, reply) => reply.json(data));

    const response = await app.inject({
      url: "/verify",
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");

    // Decompress and verify content
    const ds = new DecompressionStream("gzip");
    const decompressed = response.body?.pipeThrough(ds);
    const reader = decompressed.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    expect(JSON.parse(text)).toEqual(data);
  });
});
