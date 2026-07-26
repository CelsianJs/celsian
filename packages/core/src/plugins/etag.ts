// @celsian/core, ETag utility for conditional requests

export interface ETagOptions {
  /** Use weak ETags (default: true) */
  weak?: boolean;
}

const textEncoder = new TextEncoder();

/**
 * Hash a body for use as an ETag: SHA-256 truncated to 128 bits.
 *
 * The previous 32-bit non-cryptographic hash collided easily, and an ETag
 * collision is not cosmetic: it makes the server answer 304 for a body the
 * client has never seen.
 */
async function hashBody(str: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(str));
  const bytes = new Uint8Array(digest, 0, 16);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Helper to create a conditional response with ETag support.
 * Use this in route handlers for fine-grained control:
 *
 * ```ts
 * app.get('/data', async (req, reply) => {
 *   const data = getExpensiveData();
 *   return await withETag(req, data);
 * });
 * ```
 */
export async function withETag(request: Request, data: unknown, options?: ETagOptions): Promise<Response> {
  const weak = options?.weak !== false;
  const body = typeof data === "string" ? data : JSON.stringify(data);
  const hash = await hashBody(body);
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
