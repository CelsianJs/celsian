import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const TMP_DIR = join(import.meta.dirname ?? ".", "__tmp_conditional_get__");

beforeAll(async () => {
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(join(TMP_DIR, "hello.txt"), "Hello World");
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("Conditional GET (304 Not Modified)", () => {
  it("should return 304 when If-None-Match matches ETag", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "hello.txt"), { request: req }),
    );

    // First request to get ETag
    const fullRes = await app.handle(new Request("http://localhost/file"));
    expect(fullRes.status).toBe(200);
    const etag = fullRes.headers.get("etag")!;
    expect(etag).toBeTruthy();

    // Second request with If-None-Match
    const cachedRes = await app.handle(
      new Request("http://localhost/file", {
        headers: { "if-none-match": etag },
      }),
    );
    expect(cachedRes.status).toBe(304);
    const body = await cachedRes.text();
    expect(body).toBe("");
  });

  it("should return 200 when If-None-Match does not match", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "hello.txt"), { request: req }),
    );

    const res = await app.handle(
      new Request("http://localhost/file", {
        headers: { "if-none-match": '"stale-etag"' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("Hello World");
  });

  it("should return 304 when If-Modified-Since is after file mtime", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "hello.txt"), { request: req }),
    );

    // Get Last-Modified from first request
    const fullRes = await app.handle(new Request("http://localhost/file"));
    const lastModified = fullRes.headers.get("last-modified")!;
    expect(lastModified).toBeTruthy();

    // Request with If-Modified-Since set to same time
    const cachedRes = await app.handle(
      new Request("http://localhost/file", {
        headers: { "if-modified-since": lastModified },
      }),
    );
    expect(cachedRes.status).toBe(304);
  });

  it("should return 200 when If-Modified-Since is before file mtime", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "hello.txt"), { request: req }),
    );

    // Use a very old date
    const res = await app.handle(
      new Request("http://localhost/file", {
        headers: { "if-modified-since": "Mon, 01 Jan 2001 00:00:00 GMT" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("should prefer If-None-Match over If-Modified-Since", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "hello.txt"), { request: req }),
    );

    const fullRes = await app.handle(new Request("http://localhost/file"));
    const etag = fullRes.headers.get("etag")!;
    const lastModified = fullRes.headers.get("last-modified")!;

    // If-None-Match does NOT match, but If-Modified-Since DOES match
    // Per HTTP spec, If-None-Match takes priority → should return 200
    const res = await app.handle(
      new Request("http://localhost/file", {
        headers: {
          "if-none-match": '"wrong-etag"',
          "if-modified-since": lastModified,
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("should return 304 for download() with If-None-Match", async () => {
    const app = createApp();
    app.get("/dl", async (req, reply) =>
      reply.download(join(TMP_DIR, "hello.txt"), "file.txt", { request: req }),
    );

    const fullRes = await app.handle(new Request("http://localhost/dl"));
    expect(fullRes.status).toBe(200);
    const etag = fullRes.headers.get("etag")!;

    const cachedRes = await app.handle(
      new Request("http://localhost/dl", {
        headers: { "if-none-match": etag },
      }),
    );
    expect(cachedRes.status).toBe(304);
  });

  it("should NOT check conditional headers when request is not passed", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) =>
      reply.sendFile(join(TMP_DIR, "hello.txt")),
    );

    // Even with If-None-Match, without passing request, it should serve full
    const res = await app.handle(
      new Request("http://localhost/file", {
        headers: { "if-none-match": '"anything"' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("Hello World");
  });

  it("should include ETag and Last-Modified in 304 response", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "hello.txt"), { request: req }),
    );

    const fullRes = await app.handle(new Request("http://localhost/file"));
    const etag = fullRes.headers.get("etag")!;

    const cachedRes = await app.handle(
      new Request("http://localhost/file", {
        headers: { "if-none-match": etag },
      }),
    );
    expect(cachedRes.status).toBe(304);
    expect(cachedRes.headers.get("etag")).toBe(etag);
    expect(cachedRes.headers.get("last-modified")).toBeTruthy();
  });
});
