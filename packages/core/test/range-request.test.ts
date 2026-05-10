import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const TMP_DIR = join(import.meta.dirname ?? ".", "__tmp_range_request__");
const FILE_CONTENT = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 36 bytes

beforeAll(async () => {
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(join(TMP_DIR, "data.txt"), FILE_CONTENT);
  await writeFile(join(TMP_DIR, "video.mp4"), Buffer.alloc(10000, 0x42));
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("Range request support in sendFile", () => {
  it("should return Accept-Ranges: bytes header on normal response", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });

  it("should include ETag header", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(200);
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(etag).toMatch(/^"[a-z0-9]+-[a-z0-9]+-[a-z0-9.]+"$/);
  });

  it("should include Last-Modified header", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(200);
    expect(response.headers.get("last-modified")).toBeTruthy();
  });

  it("should include Content-Length header", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(new Request("http://localhost/file"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("36");
  });

  it("should return 206 Partial Content for single range", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: { range: "bytes=0-9" },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-9/36");
    expect(response.headers.get("content-length")).toBe("10");
    const body = await response.text();
    expect(body).toBe("0123456789");
  });

  it("should handle open-ended range (start-)", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: { range: "bytes=26-" },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 26-35/36");
    const body = await response.text();
    expect(body).toBe("QRSTUVWXYZ");
  });

  it("should handle suffix range (-N for last N bytes)", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: { range: "bytes=-5" },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 31-35/36");
    const body = await response.text();
    expect(body).toBe("VWXYZ");
  });

  it("should return 416 for unsatisfiable range", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: { range: "bytes=100-200" },
      }),
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */36");
  });

  it("should return 416 for malformed range", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: { range: "invalid-range" },
      }),
    );

    expect(response.status).toBe(416);
  });

  it("should handle multi-range requests with multipart response", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: { range: "bytes=0-4, 10-14" },
      }),
    );

    expect(response.status).toBe(206);
    const contentType = response.headers.get("content-type");
    expect(contentType).toContain("multipart/byteranges");

    const body = await response.text();
    expect(body).toContain("01234");
    expect(body).toContain("ABCDE");
  });

  it("should clamp end range to file size", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: { range: "bytes=30-999" },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 30-35/36");
    const body = await response.text();
    expect(body).toBe("UVWXYZ");
  });
});

describe("If-Range conditional ranges", () => {
  it("should serve partial content when If-Range ETag matches", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    // First, get the ETag
    const fullResponse = await app.handle(new Request("http://localhost/file"));
    const etag = fullResponse.headers.get("etag")!;

    // Then request with matching If-Range
    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: {
          range: "bytes=0-4",
          "if-range": etag,
        },
      }),
    );

    expect(response.status).toBe(206);
    const body = await response.text();
    expect(body).toBe("01234");
  });

  it("should serve full content when If-Range ETag does not match", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: {
          range: "bytes=0-4",
          "if-range": '"stale-etag"',
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(FILE_CONTENT);
  });

  it("should serve partial when If-Range Last-Modified matches", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt"), { request: req }),
    );

    const fullResponse = await app.handle(new Request("http://localhost/file"));
    const lastModified = fullResponse.headers.get("last-modified")!;

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: {
          range: "bytes=0-4",
          "if-range": lastModified,
        },
      }),
    );

    expect(response.status).toBe(206);
    const body = await response.text();
    expect(body).toBe("01234");
  });
});

describe("Range support in download", () => {
  it("should support Range in download()", async () => {
    const app = createApp();
    app.get("/dl", async (req, reply) =>
      reply.download(join(TMP_DIR, "data.txt"), "myfile.txt", { request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/dl", {
        headers: { range: "bytes=0-4" },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="myfile.txt"');
    expect(response.headers.get("content-range")).toBe("bytes 0-4/36");
    const body = await response.text();
    expect(body).toBe("01234");
  });

  it("should include ETag and Last-Modified in download", async () => {
    const app = createApp();
    app.get("/dl", async (req, reply) =>
      reply.download(join(TMP_DIR, "data.txt"), undefined, { request: req }),
    );

    const response = await app.handle(new Request("http://localhost/dl"));
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeTruthy();
    expect(response.headers.get("last-modified")).toBeTruthy();
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });
});

describe("sendFile backward compatibility", () => {
  it("should work without request option (no Range support)", async () => {
    const app = createApp();
    app.get("/file", async (_req, reply) =>
      reply.sendFile(join(TMP_DIR, "data.txt")),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: { range: "bytes=0-4" },
      }),
    );

    // Without passing request, Range header is ignored — full response
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(FILE_CONTENT);
  });

  it("should work with root option", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile("data.txt", { root: TMP_DIR, request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: { range: "bytes=0-4" },
      }),
    );

    expect(response.status).toBe(206);
    const body = await response.text();
    expect(body).toBe("01234");
  });

  it("should still reject path traversal with root + range", async () => {
    const app = createApp();
    app.get("/file", async (req, reply) =>
      reply.sendFile("../../etc/passwd", { root: TMP_DIR, request: req }),
    );

    const response = await app.handle(
      new Request("http://localhost/file", {
        headers: { range: "bytes=0-100" },
      }),
    );

    expect(response.status).toBe(403);
  });
});
