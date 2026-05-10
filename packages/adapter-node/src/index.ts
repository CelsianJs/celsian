// @celsian/adapter-node — Standalone Node.js server adapter

import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import type { CelsianApp } from "@celsian/core";

// Inline types — will be imported from @celsian/build when ThenJS ships
type RouteManifest = Record<string, { kind: string; method: string; path: string }>;
type TaskManifest = Record<string, { name: string; handler: string }>;

// ─── Adapter Interface ───

export interface NodeAdapterOptions {
  /** Port to listen on (default: 3000 or PORT env) */
  port?: number;
  /** Host to bind (default: '0.0.0.0') */
  host?: string;
  /** Directory for static assets */
  staticDir?: string;
}

export interface ThenAdapter {
  name: string;
  buildEnd(options: {
    serverEntry: string;
    clientDir: string;
    staticDir: string;
    routes: RouteManifest;
    tasks: TaskManifest;
  }): Promise<void>;
  entryTemplate: string;
}

/** Node adapter for build output */
const nodeAdapter: ThenAdapter = {
  name: "node",

  async buildEnd() {
    // Generate a standalone server entry that:
    // 1. Imports the server bundle
    // 2. Sets up static file serving
    // 3. Starts node:http server

    const _entryCode = `
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Import the built server
import app from './entry-server.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIR = join(__dirname, '../client');
const STATIC_DIR = join(__dirname, '../static');
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function tryStaticFile(pathname, dirs) {
  // Decode URI to handle encoded traversal sequences (e.g., %2e%2e%2f)
  const decodedPath = decodeURIComponent(pathname);
  for (const dir of dirs) {
    const { resolve: resolvePath } = await import('node:path');
    const resolvedRoot = resolvePath(dir);
    const filePath = resolvePath(join(dir, decodedPath));
    // Prevent path traversal — resolved path must be within the static root
    if (!filePath.startsWith(resolvedRoot + '/') && filePath !== resolvedRoot) {
      continue;
    }
    try {
      const s = await stat(filePath);
      if (s.isFile()) {
        const content = await readFile(filePath);
        const ext = extname(filePath);
        return { content, mime: MIME_TYPES[ext] ?? 'application/octet-stream' };
      }
    } catch {}
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', \`http://\${HOST}:\${PORT}\`);

  // Try static files first
  const staticResult = await tryStaticFile(url.pathname, [CLIENT_DIR, STATIC_DIR]);
  if (staticResult) {
    res.setHeader('content-type', staticResult.mime);
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.end(staticResult.content);
    return;
  }

  // Convert to Web Standard Request
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const webRequest = new Request(url.toString(), {
    method: req.method,
    headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? 'half' : undefined,
  });

  // Handle with CelsianApp
  const response = await (typeof app.handle === 'function' ? app.handle(webRequest) : app.fetch(webRequest));

  // Write response
  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) {
    res.setHeader(key, value);
  }

  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(\`[celsian] Server running at http://\${HOST}:\${PORT}\`);
});
`;

    // In a real implementation, write this to disk
    console.log("[celsian:adapter-node] Generated server entry");
  },

  entryTemplate: "node-server",
};

export default nodeAdapter;

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
      // Decode URI and resolve to prevent path traversal (e.g., /../../../etc/passwd)
      const decodedPath = decodeURIComponent(url.pathname);
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
    res.setHeader(key, value);
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
