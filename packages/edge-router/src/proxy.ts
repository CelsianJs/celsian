import { applyRewrite } from "./match.js";
import type { RouteMatch } from "./types.js";

/**
 * Proxy a request to the matched route's origin backend.
 *
 * - Rewrites the URL path if the route has a `rewrite` pattern
 * - Forwards query string and headers
 * - Adds any route-level custom headers
 * - Adds X-Forwarded-* headers
 */
export async function proxyRequest(request: Request, match: RouteMatch): Promise<Response> {
  const { route, params } = match;
  const origin = route.entry.origin;
  const url = new URL(request.url);

  // Determine the target path
  let targetPath: string;
  if (route.entry.rewrite) {
    targetPath = applyRewrite(route.entry.rewrite, params);
  } else {
    targetPath = url.pathname;
  }

  // Build the target URL: origin base + target path + original query string
  const originUrl = new URL(origin);
  const targetUrl = new URL(originUrl.origin + targetPath + url.search);

  // Build forwarded headers
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Host", url.hostname);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? "127.0.0.1");

  // Add route-level custom headers
  if (route.entry.headers) {
    for (const [key, value] of Object.entries(route.entry.headers)) {
      headers.set(key, value);
    }
  }

  // Proxy the request
  const proxyReq = new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    redirect: "manual",
  });

  return fetch(proxyReq);
}
