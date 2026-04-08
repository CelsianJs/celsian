import { applyRewrite } from "./match.js";
import type { RouteMatch } from "./types.js";

/**
 * Check if a URL hostname resolves to an internal/private IP range.
 * Prevents SSRF by blocking requests to internal origins.
 */
export function isInternalUrl(url: URL): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // IPv4 loopback 127.0.0.0/8
  if (hostname.startsWith("127.") || hostname === "localhost") return true;

  // 10.0.0.0/8
  if (hostname.startsWith("10.")) return true;

  // 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  if (hostname.startsWith("172.")) {
    const second = Number.parseInt(hostname.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  // 192.168.0.0/16
  if (hostname.startsWith("192.168.")) return true;

  // 0.0.0.0
  if (hostname === "0.0.0.0") return true;

  // IPv6 loopback
  if (hostname === "::1") return true;

  // IPv6 private (fc00::/7 covers fc00:: and fd00::)
  if (hostname.toLowerCase().startsWith("fd") || hostname.toLowerCase().startsWith("fc")) {
    // More precise: check fc00::/7 — first two hex chars are fc or fd
    const lower = hostname.toLowerCase();
    if (lower.startsWith("fd00:") || lower.startsWith("fc00:") || lower === "fd00" || lower === "fc00") return true;
    // Also catch any fd.../fc... IPv6 address
    if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  }

  return false;
}

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

  // SSRF protection: reject internal origins
  const originUrl = new URL(origin);
  if (isInternalUrl(originUrl)) {
    return Response.json({ error: "Forbidden: internal origins not allowed" }, { status: 403 });
  }

  // Determine the target path
  let targetPath: string;
  if (route.entry.rewrite) {
    targetPath = applyRewrite(route.entry.rewrite, params);
  } else {
    targetPath = url.pathname;
  }

  // Build the target URL: origin base + target path + original query string
  const targetUrl = new URL(originUrl.origin + targetPath + url.search);

  // Build forwarded headers
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Host", url.hostname);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "unknown");

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
