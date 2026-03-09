// @celsian/core — Request builder

import type { CelsianRequest } from './types.js';

export function buildRequest(
  request: Request,
  url: URL,
  params: Record<string, string>,
): CelsianRequest {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const existing = query[key];
    if (existing !== undefined) {
      query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      query[key] = value;
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
  Object.defineProperty(celsianRequest, 'body', { get: () => request.body, configurable: true, enumerable: true });
  Object.defineProperty(celsianRequest, 'bodyUsed', { get: () => request.bodyUsed, configurable: true, enumerable: true });

  // Copy any custom properties set on the request (e.g., env/ctx from Cloudflare adapter)
  for (const key of Object.keys(request)) {
    if (!(key in celsianRequest)) {
      (celsianRequest as Record<string, unknown>)[key] = (request as unknown as Record<string, unknown>)[key];
    }
  }

  return celsianRequest;
}
