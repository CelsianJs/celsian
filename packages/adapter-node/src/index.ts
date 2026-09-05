// @celsian/adapter-node, Standalone Node.js server adapter

import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { type CelsianApp, nodeToWebRequest, writeWebResponse } from "@celsian/core";

// Keep stream ownership and HTTP conversion identical to the built-in Node server.
export { nodeToWebRequest, writeWebResponse } from "@celsian/core";

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
      // Malformed percent-encoding (e.g. "/%ZZ") throws URIError, respond 400
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
      if (!res.destroyed) {
        console.error("[celsian] Unhandled error:", error);
        if (res.headersSent) res.destroy();
        else await writeWebResponse(res, new Response("Internal Server Error", { status: 500 }));
      }
    }
  });

  server.listen(port, host, () => {
    console.log(`[celsian] Server running at http://${host}:${port}`);
  });
}

export default serve;
