// @celsian/adapter-node — Standalone Node.js server adapter

import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import type { CelsianApp } from "@celsian/core";

// ─── Removed: build adapter ───
//
// This package used to also export a build adapter (`default` export with a
// `buildEnd()` hook and an `entryTemplate`) for a `@celsian/build` pipeline that
// does not exist. `buildEnd()` could only throw, and `defineConfig({ build: ... })`
// has no `build` key on CelsianConfig. The whole surface has been removed rather
// than shipped as a documented API that cannot work. The supported way to run a
// CelsianApp on Node.js is the runtime `serve(app, options)` export below.

export interface NodeAdapterOptions {
  /** Port to listen on (default: 3000 or PORT env) */
  port?: number;
  /** Host to bind (default: '0.0.0.0') */
  host?: string;
  /** Directory for static assets */
  staticDir?: string;
}

// ─── Runtime: Start a Node server from a CelsianApp ───

export function serve(app: CelsianApp, options: NodeAdapterOptions = {}): void {
  const port = options.port ?? parseInt(process.env.PORT ?? "3000", 10);
  const host = options.host ?? "0.0.0.0";
  const staticDir = options.staticDir;

  const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    // Try static files
    if (staticDir) {
      // Decode URI and resolve to prevent path traversal (e.g., /../../../etc/passwd).
      // Malformed percent-encoding (e.g. "/%ZZ") throws URIError — respond 400
      // instead of letting it escape the async server callback.
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch {
        res.statusCode = 400;
        res.end("Bad Request");
        return;
      }
      const resolvedRoot = resolve(staticDir);
      const filePath = resolve(join(staticDir, decodedPath));
      // Ensure the resolved path is within the static directory
      if (filePath.startsWith(`${resolvedRoot}/`) || filePath === resolvedRoot) {
        try {
          const s = await stat(filePath);
          if (s.isFile()) {
            const content = await readFile(filePath);
            const ext = extname(filePath);
            res.setHeader("content-type", MIME_TYPES[ext] ?? "application/octet-stream");
            res.setHeader("cache-control", "public, max-age=31536000, immutable");
            res.end(content);
            return;
          }
        } catch {
          // Not a static file, continue
        }
      }
    }

    // Convert Node request to Web Standard Request
    const webRequest = nodeToWebRequest(req, url);

    try {
      const response = await app.handle(webRequest);
      await writeWebResponse(res, response);
    } catch (error) {
      console.error("[celsian] Unhandled error:", error);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  server.listen(port, host, () => {
    console.log(`[celsian] Server running at http://${host}:${port}`);
  });
}

// ─── Conversion Helpers ───

export function nodeToWebRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(url.toString(), {
    method,
    headers,
    body: hasBody ? (req as unknown as ReadableStream) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;

  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue; // handled below
    res.setHeader(key, value);
  }

  // Headers.entries() collapses repeated Set-Cookie into one comma-joined value,
  // which corrupts cookies containing commas (e.g. Expires dates). Write the
  // array form so every cookie gets its own header line.
  const cookies = (response.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    res.setHeader("set-cookie", cookies);
  }

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
}

export default serve;
