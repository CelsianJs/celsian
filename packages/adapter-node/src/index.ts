// @celsian/adapter-node, Standalone Node.js server adapter

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { type CelsianApp, HttpError, nodeToWebRequest, readConfinedFile, writeWebResponse } from "@celsian/core";

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

function requestUrl(target: string, baseUrl: string): URL {
  if (target.includes("#") || target.includes("\\")) throw new HttpError(400, "Bad Request");
  // Even leading // is an origin-form path, not a network-path authority.
  if (target.charCodeAt(0) === 47) return new URL(baseUrl + target);
  const authority = /^https?:\/\/([^/?#]+)/i.exec(target)?.[1];
  if (!authority || authority.includes("@")) throw new HttpError(400, "Bad Request");
  const url = new URL(target);
  if (!url.hostname || url.username || url.password) throw new HttpError(400, "Bad Request");
  return url;
}

export function serve(app: CelsianApp, options: NodeAdapterOptions = {}): void {
  const port = options.port ?? parseInt(process.env.PORT ?? "3000", 10);
  const host = options.host ?? "0.0.0.0";
  const staticDir = options.staticDir;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  let baseUrl = `http://${displayHost}:${port}`;

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
    try {
      const target = req.url ?? "/";
      let url: URL;
      try {
        url = requestUrl(target, baseUrl);
      } catch {
        throw new HttpError(400, "Bad Request");
      }

      // Try static files
      if (staticDir) {
        // Decode URI and resolve to prevent path traversal (e.g., /../../../etc/passwd).
        // Malformed percent-encoding (e.g. "/%ZZ") throws URIError, respond 400
        // instead of letting it escape the async server callback.
        let decodedPath: string;
        try {
          decodedPath = decodeURIComponent(url.pathname);
        } catch {
          throw new HttpError(400, "Bad Request");
        }
        const staticRoot = resolve(staticDir);
        // `join` first, then confine: a URL path is always absolute ("/app.js"),
        // and `resolve(root, "/app.js")` would replace the root outright.
        const filePath = resolve(join(staticRoot, decodedPath));
        // Containment is delegated to the helper core's serve() and
        // reply.sendFile() use. This was a second copy of the static-file logic
        // that kept only the lexical check (`startsWith` on the resolved path,
        // then stat + readFile by name), so a symlink inside staticDir served
        // whatever it pointed at: `GET /avatar.png` returning `.env` with a 200.
        // The helper also compares realpath()s and reads through one
        // O_NOFOLLOW handle, so the check and the read cannot disagree.
        //
        // A rejection falls through to the app handler, as a traversal attempt
        // already did, so this layer never reports on files outside its root.
        const file = await readConfinedFile(filePath, { root: staticRoot });
        if (file.ok) {
          // Extension comes from the requested path, not the resolved one.
          const ext = extname(filePath);
          res.setHeader("content-type", MIME_TYPES[ext] ?? "application/octet-stream");
          res.setHeader("cache-control", "public, max-age=31536000, immutable");
          res.end(file.data);
          return;
        }
      }

      // Convert Node request to Web Standard Request
      let webRequest: Request;
      try {
        webRequest = nodeToWebRequest(req, url);
        // Absolute-form target authority takes precedence over the received Host.
        if (target.charCodeAt(0) !== 47) webRequest.headers.set("host", url.host);
      } catch {
        throw new HttpError(400, "Bad Request");
      }
      const response = await app.handle(webRequest);
      await writeWebResponse(res, response);
    } catch (error) {
      if (!res.destroyed) {
        try {
          const badRequest = error instanceof HttpError && error.statusCode === 400;
          if (!badRequest) console.error("[celsian] Unhandled error:", error);
          if (res.headersSent) res.destroy();
          else {
            res.statusCode = badRequest ? 400 : 500;
            res.setHeader("connection", "close");
            res.end(badRequest ? "Bad Request" : "Internal Server Error");
          }
        } catch {
          res.destroy();
        }
      }
    }
  });

  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    baseUrl = `http://${displayHost}:${boundPort}`;
    console.log(`[celsian] Server running at ${baseUrl}`);
  });
}

export default serve;
