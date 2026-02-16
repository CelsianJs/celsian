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

  // Use explicit delegation instead of Object.create(request).
  // V8 isolates (Edge, Workers) check internal slots on native Request,
  // and Object.create breaks the `this` binding for those checks.
  const celsianRequest = {
    get headers() { return request.headers; },
    get method() { return request.method; },
    get url() { return request.url; },
    get body() { return request.body; },
    get bodyUsed() { return request.bodyUsed; },
    get cache() { return request.cache; },
    get credentials() { return request.credentials; },
    get destination() { return request.destination; },
    get integrity() { return request.integrity; },
    get keepalive() { return request.keepalive; },
    get mode() { return request.mode; },
    get redirect() { return request.redirect; },
    get referrer() { return request.referrer; },
    get referrerPolicy() { return request.referrerPolicy; },
    get signal() { return request.signal; },
    json: () => request.json(),
    text: () => request.text(),
    formData: () => request.formData(),
    arrayBuffer: () => request.arrayBuffer(),
    blob: () => request.blob(),
    clone: () => request.clone(),
    params,
    query,
    parsedBody: undefined as unknown,
  } as CelsianRequest;

  // Copy any custom properties set on the request (e.g., env/ctx from Cloudflare adapter)
  for (const key of Object.keys(request)) {
    if (!(key in celsianRequest)) {
      (celsianRequest as Record<string, unknown>)[key] = (request as unknown as Record<string, unknown>)[key];
    }
  }

  return celsianRequest;
}
