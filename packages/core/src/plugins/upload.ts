// @celsian/core -- File upload / multipart parsing plugin

import { BLOCKED_KEYS } from "../body-parser.js";
import { HttpError } from "../errors.js";
import type { CelsianReply, CelsianRequest, PluginFunction } from "../types.js";

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 10;

/**
 * Magic-byte signatures for content types worth verifying. Used to catch a
 * client that declares an allowed Content-Type on bytes that are something
 * else entirely, the declared part header is trivially spoofed.
 */
const MAGIC_SIGNATURES: { mime: string; offset: number; bytes: number[] }[] = [
  { mime: "image/png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  { mime: "application/pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: "application/zip", offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: "application/gzip", offset: 0, bytes: [0x1f, 0x8b] },
];

/** MIME types we can positively identify from their bytes. */
const SNIFFABLE_MIMES = new Set(MAGIC_SIGNATURES.map((s) => s.mime));

/** Detect the content type from magic bytes, or null when unrecognized. */
function sniffMimeType(data: Uint8Array): string | null {
  for (const sig of MAGIC_SIGNATURES) {
    if (data.length < sig.offset + sig.bytes.length) continue;
    let matched = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (data[sig.offset + i] !== sig.bytes[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return sig.mime;
  }
  return null;
}

/**
 * Names Windows resolves to a device rather than a file, in any directory and
 * with any extension: `CON.txt` opens the console, not a file. Matched against
 * the stem (everything before the first dot), case-insensitively.
 */
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Reduce a client-supplied file name to a name that is safe to `join()` onto a
 * directory: directory components, NUL, control characters, surrounding
 * whitespace and leading dots removed. The original is kept as `rawFileName`
 * for display/audit only.
 *
 * The stripping runs to a FIXED POINT, which is the whole difficulty. Each pass
 * can uncover work for the other passes, so any single ordered sequence leaves
 * a hole:
 *
 * - Stripping leading dots before trimming let whitespace shield them:
 *   `" .."` survived dot-stripping intact and `trim()` then handed back a
 *   literal `".."`, so `join(uploadDir, file.fileName)` resolved to the PARENT
 *   of the upload directory. Non-breaking space and U+2028 work the same way,
 *   both being whitespace to `trim()`.
 * - Stripping trailing dots can expose trailing whitespace and vice versa.
 *
 * Trailing dots and spaces are removed because Windows removes them silently at
 * creation time: `evil.php.` passes an extension check as a `.` file and lands
 * on disk as `evil.php`.
 */
function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  let cleaned = "";
  for (const ch of base) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) continue;
    cleaned += ch;
  }

  // `trim()` already covers the full Unicode whitespace set (NBSP, U+2028,
  // U+FEFF included), so the loop is about ordering, not about coverage.
  let previous: string;
  do {
    previous = cleaned;
    cleaned = cleaned.trim();
    cleaned = cleaned.replace(/^\.+/, "");
    cleaned = cleaned.replace(/[.\s]+$/u, "");
  } while (cleaned !== previous);

  // Belt and braces: the loop above cannot leave these, but the promise this
  // function makes ("safe to join onto a directory") is worth stating twice.
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";

  const stem = cleaned.split(".")[0] ?? "";
  if (WINDOWS_RESERVED_NAMES.test(stem)) return `file_${cleaned}`;

  return cleaned;
}

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
  /**
   * Sanitized file name: basename only, with path separators, NUL, control
   * characters, surrounding whitespace, leading dots and trailing dots/spaces
   * stripped, and Windows device names (CON, NUL, COM1...) defused. Never `.`,
   * `..` or empty, so it is safe to join onto a directory. Still not unique,
   * collisions are the caller's problem.
   */
  fileName: string;
  /**
   * The file name exactly as the client sent it. ATTACKER-CONTROLLED: never
   * pass this to `join()`, `writeFile()` or any filesystem call.
   */
  rawFileName: string;
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
        // Not a multipart request, initialize empty arrays/objects so consumers can safely check
        (request as Record<string, unknown>).files = [];
        (request as Record<string, unknown>).fields = Object.create(null);
        return;
      }

      const files: UploadedFile[] = [];
      // Null-prototype + blocklist, matching body-parser.ts and cookie.ts: a
      // field literally named "__proto__" must not reach Object.prototype.
      const fields: Record<string, string> = Object.create(null);

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
          // Could not parse, treat as empty
          (request as Record<string, unknown>).files = files;
          (request as Record<string, unknown>).fields = fields;
          return;
        }
      }

      // Count and size-check every part BEFORE reading any of them into memory.
      // Both limits used to be applied after the bytes were already buffered,
      // so neither bounded memory. (The overall payload is still bounded by the
      // app's bodyLimit, which is what caps the multipart body itself.)
      let declaredFiles = 0;
      for (const [, value] of formData.entries()) {
        if (typeof value === "string") continue;
        declaredFiles++;
        if (declaredFiles > maxFiles) {
          throw new HttpError(413, `Too many files: maximum ${maxFiles} allowed`, {
            code: "TOO_MANY_FILES",
          });
        }
        const size = (value as File).size;
        if (size > maxFileSize) {
          throw new HttpError(
            413,
            `File "${sanitizeFileName((value as File).name)}" exceeds maximum size of ${maxFileSize} bytes`,
            { code: "FILE_TOO_LARGE" },
          );
        }
      }

      for (const [fieldName, value] of formData.entries()) {
        if (typeof value === "string") {
          if (!BLOCKED_KEYS.has(fieldName)) {
            fields[fieldName] = value;
          }
          continue;
        }

        // value is a File (Blob subclass in Web API)
        const file = value as File;
        const mimeType = file.type || "application/octet-stream";
        const enforceMime = allowedMimeTypes !== undefined && allowedMimeTypes.length > 0;

        if (enforceMime && !allowedMimeTypes.includes(mimeType)) {
          throw new HttpError(415, `File type "${mimeType}" is not allowed`, {
            code: "UNSUPPORTED_MEDIA_TYPE",
          });
        }

        const arrayBuffer = await file.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);

        // Defense in depth: the declared part content-type is client input, so
        // when an allow-list is configured the bytes have to agree with it.
        if (enforceMime) {
          const sniffed = sniffMimeType(data);
          if (sniffed !== null && !allowedMimeTypes.includes(sniffed)) {
            throw new HttpError(415, `File content type "${sniffed}" is not allowed`, {
              code: "UNSUPPORTED_MEDIA_TYPE",
            });
          }
          if (SNIFFABLE_MIMES.has(mimeType) && sniffed !== mimeType) {
            throw new HttpError(415, `File content does not match declared type "${mimeType}"`, {
              code: "UNSUPPORTED_MEDIA_TYPE",
            });
          }
        }

        if (data.byteLength > maxFileSize) {
          throw new HttpError(
            413,
            `File "${sanitizeFileName(file.name)}" exceeds maximum size of ${maxFileSize} bytes`,
            {
              code: "FILE_TOO_LARGE",
            },
          );
        }

        files.push({
          fieldName,
          fileName: sanitizeFileName(file.name),
          rawFileName: file.name,
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
