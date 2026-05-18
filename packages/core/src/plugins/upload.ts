// @celsian/core -- File upload / multipart parsing plugin

import { HttpError } from "../errors.js";
import type { CelsianRequest, CelsianReply, PluginFunction } from "../types.js";

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 10;

export interface UploadOptions {
  /** Maximum file size in bytes (default: 10MB) */
  maxFileSize?: number;
  /** Maximum number of files (default: 10) */
  maxFiles?: number;
  /** Allowed MIME types (e.g. ['image/png', 'image/jpeg']). If unset, all types allowed. */
  allowedMimeTypes?: string[];
}

export interface UploadedFile {
  fieldName: string;
  fileName: string;
  mimeType: string;
  size: number;
  data: Uint8Array;
  text(): string;
  arrayBuffer(): ArrayBuffer;
}

/**
 * File upload plugin that parses multipart/form-data requests.
 *
 * Populates `request.files` (array of UploadedFile) and `request.fields`
 * (record of string values) on requests with multipart content type.
 *
 * @example
 * ```ts
 * app.register(upload({ maxFileSize: 5 * 1024 * 1024 }));
 * app.post('/upload', (req) => {
 *   const files = (req as any).files as UploadedFile[];
 *   return { uploaded: files.length };
 * });
 * ```
 */
export function upload(options: UploadOptions = {}): PluginFunction {
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const allowedMimeTypes = options.allowedMimeTypes;

  return function uploadPlugin(app) {
    app.addHook("preHandler", async (request: CelsianRequest, _reply: CelsianReply) => {
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.includes("multipart/form-data")) {
        // Not a multipart request — initialize empty arrays/objects so consumers can safely check
        (request as Record<string, unknown>).files = [];
        (request as Record<string, unknown>).fields = {};
        return;
      }

      const files: UploadedFile[] = [];
      const fields: Record<string, string> = {};

      // The core body parser already calls request.formData() during parseBody,
      // storing the result in request.parsedBody. Use that instead of re-reading
      // the body stream (which would fail since it's already consumed).
      let formData: FormData;
      if (request.parsedBody instanceof FormData) {
        formData = request.parsedBody;
      } else {
        // Fallback: try parsing directly (e.g. if body parsing was skipped)
        try {
          formData = await request.formData();
        } catch {
          // Could not parse — treat as empty
          (request as Record<string, unknown>).files = files;
          (request as Record<string, unknown>).fields = fields;
          return;
        }
      }

      let fileCount = 0;

      for (const [fieldName, value] of formData.entries()) {
        if (typeof value === "string") {
          fields[fieldName] = value;
          continue;
        }

        // value is a File (Blob subclass in Web API)
        const file = value as File;
        fileCount++;

        if (fileCount > maxFiles) {
          throw new HttpError(413, `Too many files: maximum ${maxFiles} allowed`, {
            code: "TOO_MANY_FILES",
          });
        }

        const mimeType = file.type || "application/octet-stream";

        if (allowedMimeTypes && allowedMimeTypes.length > 0) {
          if (!allowedMimeTypes.includes(mimeType)) {
            throw new HttpError(415, `File type "${mimeType}" is not allowed`, {
              code: "UNSUPPORTED_MEDIA_TYPE",
            });
          }
        }

        const arrayBuffer = await file.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);

        if (data.byteLength > maxFileSize) {
          throw new HttpError(413, `File "${file.name}" exceeds maximum size of ${maxFileSize} bytes`, {
            code: "FILE_TOO_LARGE",
          });
        }

        files.push({
          fieldName,
          fileName: file.name,
          mimeType,
          size: data.byteLength,
          data,
          text() {
            return new TextDecoder().decode(this.data);
          },
          arrayBuffer() {
            return this.data.buffer.slice(
              this.data.byteOffset,
              this.data.byteOffset + this.data.byteLength,
            ) as ArrayBuffer;
          },
        });
      }

      (request as Record<string, unknown>).files = files;
      (request as Record<string, unknown>).fields = fields;
    });
  };
}
