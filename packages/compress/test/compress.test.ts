import { brotliDecompressSync } from "node:zlib";
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

describe("Brotli compression", () => {
  it("should prefer Brotli over gzip when both are accepted", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });

    app.get("/test", (_req, reply) => reply.json({ message: "hello world from brotli" }));

    const response = await app.inject({
      url: "/test",
      headers: { "accept-encoding": "gzip, br, deflate" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("vary")).toContain("accept-encoding");
  });

  it("should compress JSON with Brotli and produce decompressible output", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });

    const data = { message: "hello brotli world", numbers: [1, 2, 3, 4, 5] };
    app.get("/json", (_req, reply) => reply.json(data));

    const response = await app.inject({
      url: "/json",
      headers: { "accept-encoding": "br" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");

    // Read compressed body
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const compressed = Buffer.concat(chunks);

    // Decompress with Node.js zlib
    const decompressed = brotliDecompressSync(compressed);
    expect(JSON.parse(decompressed.toString())).toEqual(data);
  });

  it("should compress HTML with Brotli", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });

    app.get("/page", (_req, reply) => reply.html("<html><body><h1>Brotli compressed page</h1></body></html>"));

    const response = await app.inject({
      url: "/page",
      headers: { "accept-encoding": "br" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("content-type")).toContain("text/html");

    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const decompressed = brotliDecompressSync(Buffer.concat(chunks));
    expect(decompressed.toString()).toContain("Brotli compressed page");
  });

  it("should compress send() strings with Brotli", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });

    app.get("/text", (_req, reply) => reply.send("This text response is compressed with Brotli"));

    const response = await app.inject({
      url: "/text",
      headers: { "accept-encoding": "br" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");

    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const decompressed = brotliDecompressSync(Buffer.concat(chunks));
    expect(decompressed.toString()).toBe("This text response is compressed with Brotli");
  });

  it("should not use Brotli below threshold", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 1024 }), { encapsulate: false });

    app.get("/small", (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      url: "/small",
      headers: { "accept-encoding": "br" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("should support custom Brotli quality level", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10, brotliQuality: 1 }), { encapsulate: false });

    const data = { items: Array.from({ length: 50 }, (_, i) => ({ id: i })) };
    app.get("/fast-br", (_req, reply) => reply.json(data));

    const response = await app.inject({
      url: "/fast-br",
      headers: { "accept-encoding": "br" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");

    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const decompressed = brotliDecompressSync(Buffer.concat(chunks));
    expect(JSON.parse(decompressed.toString())).toEqual(data);
  });

  it("should fall back to gzip when Brotli is not in encodings list", async () => {
    const app = createApp();
    await app.register(compress({ encodings: ["gzip", "deflate"], threshold: 10 }), { encapsulate: false });

    app.get("/test", (_req, reply) => reply.json({ message: "gzip fallback" }));

    const response = await app.inject({
      url: "/test",
      headers: { "accept-encoding": "br, gzip" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  it("should respect q=0 to reject an encoding", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });

    app.get("/test", (_req, reply) => reply.json({ message: "quality negotiation" }));

    const response = await app.inject({
      url: "/test",
      headers: { "accept-encoding": "br;q=0, gzip" },
    });

    expect(response.status).toBe(200);
    // br is rejected with q=0, should fall back to gzip
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  it("should not compress when all encodings rejected with q=0", async () => {
    const app = createApp();
    await app.register(compress({ threshold: 10 }), { encapsulate: false });

    app.get("/test", (_req, reply) => reply.json({ message: "no compression" }));

    const response = await app.inject({
      url: "/test",
      headers: { "accept-encoding": "br;q=0, gzip;q=0, deflate;q=0" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
  });
});
