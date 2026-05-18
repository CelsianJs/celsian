// @celsian/core -- Body parsing with content-type detection and streaming size limits

import { HttpError } from "./errors.js";
import type { CelsianRequest } from "./types.js";

/**
 * Read the request body as text, enforcing a byte limit during streaming.
 * Rejects with 413 if the body exceeds the limit before reading completes.
 */
export async function readBodyText(request: Request, limit: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > limit) {
    throw new HttpError(413, "Payload Too Large");
  }

  if (!request.body || limit <= 0) {
    return request.text();
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        throw new HttpError(413, "Payload Too Large");
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return result;
}

/**
 * Parse the request body based on Content-Type header.
 * Supports JSON, form-urlencoded, multipart, and plain text.
 * Skips parsing for GET/HEAD or missing Content-Type.
 */
export async function parseBody(
  request: CelsianRequest,
  bodyLimit: number,
  contentTypeParsers: Map<string, (request: Request) => Promise<unknown>>,
): Promise<void> {
  const contentType = request.headers.get("content-type") ?? "";

  if (request.method === "GET" || request.method === "HEAD") {
    return;
  }

  // Check custom content-type parsers (exact match then prefix match)
  if (contentTypeParsers.size > 0) {
    for (const [registeredType, parser] of contentTypeParsers) {
      if (contentType === registeredType || contentType.startsWith(registeredType)) {
        request.parsedBody = await parser(request);
        return;
      }
    }
  }

  try {
    if (contentType.includes("application/json")) {
      try {
        const text = await readBodyText(request, bodyLimit);
        if (!text.trim()) return;
        request.parsedBody = JSON.parse(text);
      } catch (parseErr) {
        if (parseErr instanceof HttpError) throw parseErr;
        throw new HttpError(400, `Invalid JSON (content-type: ${contentType}): ${(parseErr as Error).message}`, {
          code: "INVALID_JSON",
          cause: parseErr as Error,
        });
      }
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      request.parsedBody = await request.formData();
    } else if (contentType.includes("text/")) {
      request.parsedBody = await readBodyText(request, bodyLimit);
    } else if (!contentType) {
      // No Content-Type header — skip parsing.
      // Callers must set Content-Type to get automatic body parsing.
      return;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("[celsian]", e);
  }
}
