import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const TMP_DIR = join(import.meta.dirname ?? ".", "__tmp_send_file__");

beforeAll(async () => {
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(join(TMP_DIR, "hello.txt"), "Hello World");
  await writeFile(join(TMP_DIR, "data.json"), '{"key":"value"}');
  await writeFile(join(TMP_DIR, "page.html"), "<h1>Hi</h1>");
  await writeFile(join(TMP_DIR, "style.css"), "body { color: red; }");
  await writeFile(join(TMP_DIR, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("reply.sendFile", () => {
  it("should send a text file with correct MIME type", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile(join(TMP_DIR, "hello.txt")));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body).toBe("Hello World");
  });

  it("should send JSON file with correct MIME type", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile(join(TMP_DIR, "data.json")));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("should send HTML file with correct MIME type", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile(join(TMP_DIR, "page.html")));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("should send CSS file with correct MIME type", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile(join(TMP_DIR, "style.css")));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("should send PNG file with correct MIME type", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile(join(TMP_DIR, "image.png")));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("should return 404 for non-existent file", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile(join(TMP_DIR, "nope.txt")));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("NOT_FOUND");
  });
});

describe("reply.download", () => {
  it("should send file with Content-Disposition: attachment", async () => {
    const app = createApp();
    app.get("/dl", async (_req, reply) => reply.download(join(TMP_DIR, "hello.txt")));

    const response = await app.handle(new Request("http://localhost/dl"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="hello.txt"');
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("should use custom filename", async () => {
    const app = createApp();
    app.get("/dl", async (_req, reply) => reply.download(join(TMP_DIR, "hello.txt"), "custom.txt"));

    const response = await app.handle(new Request("http://localhost/dl"));
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="custom.txt"');
  });

  it("should return 404 for non-existent file", async () => {
    const app = createApp();
    app.get("/dl", async (_req, reply) => reply.download(join(TMP_DIR, "missing.txt")));

    const response = await app.handle(new Request("http://localhost/dl"));
    expect(response.status).toBe(404);
  });
});
