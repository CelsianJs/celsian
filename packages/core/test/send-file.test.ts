import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
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

describe("reply.sendFile with root option", () => {
  it("should serve a file relative to root", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile("hello.txt", { root: TMP_DIR }));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body).toBe("Hello World");
  });

  it("should return 403 for path traversal attempts", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile("../../etc/passwd", { root: TMP_DIR }));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("PATH_TRAVERSAL");
  });

  it("should return 403 for absolute path traversal outside root", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile("/etc/passwd", { root: TMP_DIR }));

    const response = await app.handle(new Request("http://localhost/file"));
    // /etc/passwd won't start with TMP_DIR, so this should be 403
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("PATH_TRAVERSAL");
  });

  it("should reject sibling paths that share the root prefix", async () => {
    const siblingDir = `${TMP_DIR}-sibling`;
    await mkdir(siblingDir, { recursive: true });
    await writeFile(join(siblingDir, "secret.txt"), "secret");

    try {
      const app = createApp();
      app.get("/file", async (_req, reply) =>
        reply.sendFile("../__tmp_send_file__-sibling/secret.txt", { root: TMP_DIR }),
      );

      const response = await app.handle(new Request("http://localhost/file"));
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.code).toBe("PATH_TRAVERSAL");
    } finally {
      await rm(siblingDir, { recursive: true, force: true });
    }
  });

  it("should return 404 for non-existent file within root", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile("nonexistent.txt", { root: TMP_DIR }));

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

describe("sendFile cacheControl option", () => {
  it("should set Cache-Control header when cacheControl is a string", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) =>
      reply.sendFile(join(TMP_DIR, "hello.txt"), { cacheControl: "public, max-age=31536000" }),
    );

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000");
  });

  it("should not set Cache-Control header when cacheControl is false", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile(join(TMP_DIR, "hello.txt"), { cacheControl: false }));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("should not set Cache-Control header when cacheControl is omitted", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile(join(TMP_DIR, "hello.txt")));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("should set Cache-Control on download responses", async () => {
    const app = createApp();
    app.get("/dl", async (_req, reply) =>
      reply.download(join(TMP_DIR, "hello.txt"), "export.txt", { cacheControl: "no-cache" }),
    );

    const response = await app.handle(new Request("http://localhost/dl"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="export.txt"');
  });
});

describe("serveFile error differentiation", () => {
  const noAccessFile = join(TMP_DIR, "no-access.txt");

  beforeAll(async () => {
    await writeFile(noAccessFile, "secret");
    await chmod(noAccessFile, 0o000);
  });

  afterAll(async () => {
    // Restore permissions so cleanup can remove the file
    await chmod(noAccessFile, 0o644).catch(() => {});
  });

  it("should return 404 for ENOENT (file not found)", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile(join(TMP_DIR, "does-not-exist.txt")));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("should return 403 for EACCES (permission denied)", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) => reply.sendFile(noAccessFile));

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("FORBIDDEN");
  });
});
