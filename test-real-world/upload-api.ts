// Real-world test: File upload / multipart handling

import type { CelsianApp } from "../packages/core/src/app.js";
import { createApp } from "../packages/core/src/app.js";

interface FileRecord {
  id: number;
  name: string;
  size: number;
  type: string;
  uploadedAt: string;
}

export function buildUploadApp(): CelsianApp {
  const app = createApp();

  let nextId = 1;
  const files: FileRecord[] = [];

  // POST /upload — accept multipart form data
  app.post("/upload", async (req, reply) => {
    const body = req.parsedBody;

    if (!(body instanceof FormData)) {
      return reply.badRequest("Expected multipart/form-data");
    }

    const file = body.get("file");
    if (!file || !(file instanceof File)) {
      return reply.badRequest("No file field found in upload");
    }

    // Read file content to verify we can access it
    const buffer = await file.arrayBuffer();

    const record: FileRecord = {
      id: nextId++,
      name: file.name,
      size: buffer.byteLength,
      type: file.type || "application/octet-stream",
      uploadedAt: new Date().toISOString(),
    };
    files.push(record);

    return reply.status(201).json(record);
  });

  // GET /files — list uploaded files
  app.get("/files", (_req, reply) => {
    return reply.json(files);
  });

  // POST /upload-multiple — accept multiple files
  app.post("/upload-multiple", async (req, reply) => {
    const body = req.parsedBody;

    if (!(body instanceof FormData)) {
      return reply.badRequest("Expected multipart/form-data");
    }

    const uploaded: FileRecord[] = [];
    for (const [key, value] of body.entries()) {
      if (key === "files" && value instanceof File) {
        const buffer = await value.arrayBuffer();
        const record: FileRecord = {
          id: nextId++,
          name: value.name,
          size: buffer.byteLength,
          type: value.type || "application/octet-stream",
          uploadedAt: new Date().toISOString(),
        };
        files.push(record);
        uploaded.push(record);
      }
    }

    if (uploaded.length === 0) {
      return reply.badRequest("No files found in upload");
    }

    return reply.status(201).json(uploaded);
  });

  // POST /upload-with-metadata — file + text fields
  app.post("/upload-with-metadata", async (req, reply) => {
    const body = req.parsedBody;

    if (!(body instanceof FormData)) {
      return reply.badRequest("Expected multipart/form-data");
    }

    const file = body.get("file");
    const description = body.get("description");
    const category = body.get("category");

    if (!file || !(file instanceof File)) {
      return reply.badRequest("No file field found");
    }

    const buffer = await file.arrayBuffer();
    const record: FileRecord = {
      id: nextId++,
      name: file.name,
      size: buffer.byteLength,
      type: file.type || "application/octet-stream",
      uploadedAt: new Date().toISOString(),
    };
    files.push(record);

    return reply.status(201).json({
      ...record,
      description: description?.toString() ?? null,
      category: category?.toString() ?? null,
    });
  });

  return app;
}
