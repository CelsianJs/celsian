// @celsian/core — Request builder

import type { CelsianRequest } from "./types.js";

// Shared empty query object for requests with no query string
const EMPTY_QUERY: Record<string, string | string[]> = Object.freeze(Object.create(null));

// Keys that must never be set via user input (prototype pollution prevention)
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function buildRequest(request: Request, url: URL, params: Record<string, string>): CelsianRequest {
  // Use frozen empty object when there's no query string to avoid per-request allocation
  let query: Record<string, string | string[]>;
  const searchStr = url.search;
  if (!searchStr || searchStr === "?") {
    query = EMPTY_QUERY as Record<string, string | string[]>;
  } else {
    query = Object.create(null);
    for (const [key, value] of url.searchParams) {
      if (BLOCKED_KEYS.has(key)) continue;
      const existing = query[key];
      if (existing !== undefined) {
        query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        query[key] = value;
      }
    }
  }

  // Direct property assignment — avoids per-property getter closures.
  // Delegate only body-consuming methods that need the original Request's `this`.
  const celsianRequest = Object.create(null) as CelsianRequest;
  const req = celsianRequest as Record<string, unknown>;
  req.headers = request.headers;
  req.method = request.method;
  req.url = request.url;
  req.signal = request.signal;
  req.params = params;
  req.query = query;
  req.parsedBody = undefined;

  // Bind body-consuming methods (they check internal slots on the original Request)
  req.json = request.json.bind(request);
  req.text = request.text.bind(request);
  req.formData = request.formData.bind(request);
  req.arrayBuffer = request.arrayBuffer.bind(request);
  req.blob = request.blob.bind(request);
  req.clone = request.clone.bind(request);

  // Lazy getters for rarely-accessed properties
  Object.defineProperty(celsianRequest, "body", { get: () => request.body, configurable: true, enumerable: true });
  Object.defineProperty(celsianRequest, "bodyUsed", {
    get: () => request.bodyUsed,
    configurable: true,
    enumerable: true,
  });

  // Copy any custom properties set on the request (e.g., env/ctx from Cloudflare adapter)
  for (const key of Object.keys(request)) {
    if (!(key in celsianRequest)) {
      (celsianRequest as Record<string, unknown>)[key] = (request as unknown as Record<string, unknown>)[key];
    }
  }

  return celsianRequest;
}

/**
 * Fast request builder that accepts pre-parsed pathname and query string,
 * avoiding URL object creation on the hot path.
 */
export function buildRequestFast(
  request: Request,
  _pathname: string,
  queryString: string,
  params: Record<string, string>,
  _fullUrl: URL | null,
): CelsianRequest {
  // Parse query string without creating a URL object
  let query: Record<string, string | string[]>;
  if (!queryString) {
    query = EMPTY_QUERY as Record<string, string | string[]>;
  } else {
    query = Object.create(null);
    // Use URLSearchParams for correct parsing (handles encoding, +, etc.)
    const searchParams = new URLSearchParams(queryString);
    for (const [key, value] of searchParams) {
      if (BLOCKED_KEYS.has(key)) continue;
      const existing = query[key];
      if (existing !== undefined) {
        query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        query[key] = value;
      }
    }
  }

  const celsianRequest = Object.create(null) as CelsianRequest;
  const req = celsianRequest as Record<string, unknown>;
  req.headers = request.headers;
  req.method = request.method;
  req.url = request.url;
  req.signal = request.signal;
  req.params = params;
  req.query = query;
  req.parsedBody = undefined;

  // Bind body-consuming methods
  req.json = request.json.bind(request);
  req.text = request.text.bind(request);
  req.formData = request.formData.bind(request);
  req.arrayBuffer = request.arrayBuffer.bind(request);
  req.blob = request.blob.bind(request);
  req.clone = request.clone.bind(request);

  // Lazy getters for rarely-accessed properties
  Object.defineProperty(celsianRequest, "body", { get: () => request.body, configurable: true, enumerable: true });
  Object.defineProperty(celsianRequest, "bodyUsed", {
    get: () => request.bodyUsed,
    configurable: true,
    enumerable: true,
  });

  // Copy any custom properties set on the request (e.g., env/ctx from Cloudflare adapter)
  const requestKeys = Object.keys(request);
  if (requestKeys.length > 0) {
    for (const key of requestKeys) {
      if (!(key in celsianRequest)) {
        (celsianRequest as Record<string, unknown>)[key] = (request as unknown as Record<string, unknown>)[key];
      }
    }
  }

  return celsianRequest;
}
