// @celsian/core — Test injection utility (no server needed)

import type { CelsianApp } from "./app.js";
import type { RouteMethod } from "./types.js";

export interface InjectOptions {
  method?: RouteMethod;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
  query?: Record<string, string>;
  /**
   * Cookies to send, serialized into a single `Cookie` header.
   *
   * `packages/core/README.md` documented this key long before it existed, so
   * every test that used it silently sent no cookies and asserted against a
   * request that had none. An explicit `headers.cookie` still wins, so a test
   * can hand-craft a malformed header when that is the point.
   */
  cookies?: Record<string, string>;
}

export function createInject(app: CelsianApp) {
  return async function inject(options: InjectOptions): Promise<Response> {
    let url = options.url;

    // Append query params
    if (options.query) {
      const params = new URLSearchParams(options.query);
      const separator = url.includes("?") ? "&" : "?";
      url = url + separator + params.toString();
    }

    // Ensure absolute URL
    if (!url.startsWith("http")) {
      url = `http://localhost${url.startsWith("/") ? "" : "/"}${url}`;
    }

    const method = options.method ?? "GET";
    const headers = new Headers(options.headers);

    if (options.cookies && !headers.has("cookie")) {
      const pairs = Object.entries(options.cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
      if (pairs.length > 0) headers.set("cookie", pairs.join("; "));
    }

    let body: string | undefined;
    if (options.payload !== undefined) {
      if (typeof options.payload === "string") {
        body = options.payload;
        if (!headers.has("content-type")) {
          headers.set("content-type", "text/plain");
        }
      } else {
        body = JSON.stringify(options.payload);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
      }
    }

    const request = new Request(url, {
      method,
      headers,
      body,
    });

    return app.handle(request);
  };
}
