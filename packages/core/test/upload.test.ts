import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type UploadedFile, upload } from "../src/plugins/upload.js";

/**
 * Helper: build a multipart/form-data Request from files and fields.
 */
function multipartRequest(
  url: string,
  parts: {
    files?: { field: string; name: string; type: string; content: string | Uint8Array }[];
    fields?: Record<string, string>;
  },
): Request {
  const formData = new FormData();

  if (parts.fields) {
    for (const [key, value] of Object.entries(parts.fields)) {
      formData.append(key, value);
    }
  }

  if (parts.files) {
    for (const f of parts.files) {
      const data = typeof f.content === "string" ? new TextEncoder().encode(f.content) : f.content;
      const blob = new Blob([data], { type: f.type });
      formData.append(f.field, new File([blob], f.name, { type: f.type }));
    }
  }

  return new Request(`http://localhost${url}`, {
    method: "POST",
    body: formData,
  });
}

describe("Upload Plugin", () => {
  it("should parse a single file upload", async () => {
    const app = createApp();
    await app.register(upload(), { encapsulate: false });
    app.post("/upload", (req, reply) => {
      const files = (req as Record<string, unknown>).files as UploadedFile[];
      return reply.json({
        count: files.length,
        name: files[0]?.fileName,
        mime: files[0]?.mimeType,
        text: files[0]?.text(),
      });
    });

    const request = multipartRequest("/upload", {
      files: [{ field: "avatar", name: "photo.png", type: "image/png", content: "fake png data" }],
    });

    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.count).toBe(1);
    expect(body.name).toBe("photo.png");
    expect(body.mime).toBe("image/png");
    expect(body.text).toBe("fake png data");
  });

  it("should parse multiple files", async () => {
    const app = createApp();
    await app.register(upload(), { encapsulate: false });
    app.post("/upload", (req, reply) => {
      const files = (req as Record<string, unknown>).files as UploadedFile[];
      return reply.json({
        count: files.length,
        names: files.map((f) => f.fileName),
      });
    });

    const request = multipartRequest("/upload", {
      files: [
        { field: "file1", name: "a.txt", type: "text/plain", content: "aaa" },
        { field: "file2", name: "b.txt", type: "text/plain", content: "bbb" },
        { field: "file3", name: "c.txt", type: "text/plain", content: "ccc" },
      ],
    });

    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.count).toBe(3);
    expect(body.names).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("should enforce file size limit with 413", async () => {
    const app = createApp();
    await app.register(upload({ maxFileSize: 10 }), { encapsulate: false }); // 10 bytes max
    app.post("/upload", (req, reply) => {
      return reply.json({ ok: true });
    });

    const request = multipartRequest("/upload", {
      files: [
        {
          field: "big",
          name: "large.bin",
          type: "application/octet-stream",
          content: "this content is definitely more than 10 bytes",
        },
      ],
    });

    const response = await app.handle(request);
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.code).toBe("FILE_TOO_LARGE");
  });

  it("should enforce max files limit with 413", async () => {
    const app = createApp();
    await app.register(upload({ maxFiles: 2 }), { encapsulate: false });
    app.post("/upload", (req, reply) => {
      return reply.json({ ok: true });
    });

    const request = multipartRequest("/upload", {
      files: [
        { field: "f1", name: "a.txt", type: "text/plain", content: "a" },
        { field: "f2", name: "b.txt", type: "text/plain", content: "b" },
        { field: "f3", name: "c.txt", type: "text/plain", content: "c" },
      ],
    });

    const response = await app.handle(request);
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.code).toBe("TOO_MANY_FILES");
  });

  it("should enforce mime type restriction with 415", async () => {
    const app = createApp();
    await app.register(upload({ allowedMimeTypes: ["image/png", "image/jpeg"] }), { encapsulate: false });
    app.post("/upload", (req, reply) => {
      return reply.json({ ok: true });
    });

    const request = multipartRequest("/upload", {
      files: [{ field: "doc", name: "evil.exe", type: "application/x-executable", content: "bad" }],
    });

    const response = await app.handle(request);
    expect(response.status).toBe(415);
    const body = await response.json();
    expect(body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("should parse mixed files and fields", async () => {
    const app = createApp();
    await app.register(upload(), { encapsulate: false });
    app.post("/upload", (req, reply) => {
      const files = (req as Record<string, unknown>).files as UploadedFile[];
      const fields = (req as Record<string, unknown>).fields as Record<string, string>;
      return reply.json({
        fileCount: files.length,
        fileName: files[0]?.fileName,
        description: fields.description,
        category: fields.category,
      });
    });

    const request = multipartRequest("/upload", {
      files: [{ field: "attachment", name: "doc.pdf", type: "application/pdf", content: "pdf content" }],
      fields: { description: "A test document", category: "docs" },
    });

    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fileCount).toBe(1);
    expect(body.fileName).toBe("doc.pdf");
    expect(body.description).toBe("A test document");
    expect(body.category).toBe("docs");
  });

  it("should handle empty multipart body", async () => {
    const app = createApp();
    await app.register(upload(), { encapsulate: false });
    app.post("/upload", (req, reply) => {
      const files = (req as Record<string, unknown>).files as UploadedFile[];
      const fields = (req as Record<string, unknown>).fields as Record<string, string>;
      return reply.json({
        fileCount: files.length,
        fieldCount: Object.keys(fields).length,
      });
    });

    // Send a multipart request with no files or fields
    const request = multipartRequest("/upload", {});

    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fileCount).toBe(0);
    expect(body.fieldCount).toBe(0);
  });

  it("should initialize files/fields as empty on non-multipart requests", async () => {
    const app = createApp();
    await app.register(upload(), { encapsulate: false });
    app.post("/data", (req, reply) => {
      const files = (req as Record<string, unknown>).files as UploadedFile[];
      const fields = (req as Record<string, unknown>).fields as Record<string, string>;
      return reply.json({
        fileCount: files.length,
        fieldCount: Object.keys(fields).length,
        body: req.parsedBody,
      });
    });

    const response = await app.handle(
      new Request("http://localhost/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fileCount).toBe(0);
    expect(body.fieldCount).toBe(0);
    expect(body.body).toEqual({ hello: "world" });
  });

  it("should expose arrayBuffer() on uploaded files", async () => {
    const app = createApp();
    await app.register(upload(), { encapsulate: false });
    app.post("/upload", (req, reply) => {
      const files = (req as Record<string, unknown>).files as UploadedFile[];
      const ab = files[0]?.arrayBuffer();
      return reply.json({
        size: files[0]?.size,
        bufferByteLength: ab?.byteLength,
      });
    });

    const content = "hello upload";
    const request = multipartRequest("/upload", {
      files: [{ field: "file", name: "test.txt", type: "text/plain", content }],
    });

    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.size).toBe(new TextEncoder().encode(content).length);
    expect(body.bufferByteLength).toBe(body.size);
  });
});
