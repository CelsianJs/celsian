// @celsian/core — ETag utility for conditional requests

export interface ETagOptions {
  /** Use weak ETags (default: true) */
  weak?: boolean;
}

/**
 * Generate a simple hash for ETag.
 * Uses a fast non-cryptographic hash for performance.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Helper to create a conditional response with ETag support.
 * Use this in route handlers for fine-grained control:
 *
 * ```ts
 * app.get('/data', (req, reply) => {
 *   const data = getExpensiveData();
 *   return withETag(req, data);
 * });
 * ```
 */
export function withETag(request: Request, data: unknown, options?: ETagOptions): Response {
  const weak = options?.weak !== false;
  const body = typeof data === "string" ? data : JSON.stringify(data);
  const hash = simpleHash(body);
  const etagValue = weak ? `W/"${hash}"` : `"${hash}"`;

  // Check If-None-Match
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch === etagValue) {
    return new Response(null, {
      status: 304,
      headers: { etag: etagValue },
    });
  }

  const contentType = typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      etag: etagValue,
    },
  });
}
