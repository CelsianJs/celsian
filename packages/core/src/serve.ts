// @celsian/core — Built-in server (Node.js / Bun / Deno runtime detection)

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CelsianApp } from "./app.js";

/** Options for `serve()` -- port, host, static files, graceful shutdown. */
export interface ServeOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  signal?: AbortSignal;
  onReady?: (info: { port: number; host: string }) => void;
  /** Graceful shutdown timeout in ms (default: 10_000) */
  shutdownTimeout?: number;
  /** Cleanup hook called during graceful shutdown */
  onShutdown?: () => Promise<void> | void;
}

/** Handle returned by `serve()` for programmatic shutdown. */
export interface ServeResult {
  close: () => Promise<void>;
  port?: number;
  host?: string;
}

/**
 * Start the HTTP server with automatic runtime detection (Node.js, Bun, Deno).
 * Starts the task worker and cron scheduler, registers graceful shutdown handlers.
 *
 * @example
 * ```ts
 * const { close } = await serve(app, { port: 3000 });
 * ```
 */
export async function serve(app: CelsianApp, options: ServeOptions = {}): Promise<ServeResult> {
  // Wait for all plugins to load
  await app.ready();

  // Load config file if present (options override config)
  let configPort = 3000;
  let configHost = "0.0.0.0";
  try {
    const { loadConfig } = await import("./config.js");
    const config = await loadConfig();
    configPort = config.server?.port ?? configPort;
    configHost = config.server?.host ?? configHost;
  } catch {
    // Config loading failed — use defaults
  }

  // Start task worker and cron scheduler
  app.startWorker();
  app.startCron();

  const port = options.port ?? parseInt(process.env.PORT || String(configPort), 10);
  const host = options.host ?? configHost;

  // Bun runtime detection
  if (typeof (globalThis as any).Bun !== "undefined") {
    return serveBun(app, port, host, options);
  }

  // Deno runtime detection
  if (typeof (globalThis as any).Deno !== "undefined") {
    return serveDeno(app, port, host, options);
  }

  // Default: Node.js
  return serveNode(app, port, host, options);
}

async function serveNode(app: CelsianApp, port: number, host: string, options: ServeOptions): Promise<ServeResult> {
  const http = await import("node:http");
  const { readFile, stat } = await import("node:fs/promises");
  const { join, extname } = await import("node:path");

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

  let inFlight = 0;
  let shuttingDown = false;
  const shutdownTimeout = options.shutdownTimeout ?? 10_000;

  const staticDir = options.staticDir;
  const hasStaticDir = !!staticDir;
  const boundPort = () => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : port;
  };

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (shuttingDown) {
      res.statusCode = 503;
      res.end("Service Unavailable");
      return;
    }

    inFlight++;

    try {
      // Static files — only parse URL when staticDir is configured
      if (hasStaticDir) {
        const requestHost = req.headers.host ?? `${host}:${boundPort()}`;
        const baseUrl = `http://${requestHost}`;
        const url = new URL(req.url ?? "/", baseUrl);
        const { resolve } = await import("node:path");
        const staticRoot = resolve(staticDir);

        let decodedPath: string;
        try {
          // Decode URI and normalize to prevent path traversal (e.g., /../../../etc/passwd)
          decodedPath = decodeURIComponent(url.pathname);
        } catch (error) {
          if (error instanceof URIError) {
            res.statusCode = 400;
            res.end("Bad Request");
            return;
          }
          throw error;
        }

        const filePath = resolve(join(staticRoot, decodedPath));
        // Ensure the resolved path is within the static directory
        if (!filePath.startsWith(`${staticRoot}/`) && filePath !== staticRoot) {
          // Path traversal attempt — fall through to app handler
        } else {
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
            // Not a static file
          }
        }
      }

      // Build Web Request with raw path (let app.handle() do fast URL parsing)
      const requestHost = req.headers.host ?? `${host}:${boundPort()}`;
      const webRequest = nodeToWebRequestFast(req, req.url ?? "/", `http://${requestHost}`);

      try {
        const response = await app.handle(webRequest);
        await writeWebResponse(res, response);
      } catch (error) {
        console.error("[celsian] Unhandled error:", error);
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    } finally {
      inFlight--;
    }
  });

  // Graceful shutdown
  let shutdownPromise: Promise<void> | null = null;
  const cleanupListeners = () => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    options.signal?.removeEventListener("abort", onAbort);
  };

  const handleShutdown = async () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;

    shutdownPromise = (async () => {
      try {
        app.log.info("shutting down gracefully");

        // Stop accepting new connections
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
              reject(error);
              return;
            }
            resolve();
          });
        });

        // Wait for in-flight requests to drain
        const deadline = Date.now() + shutdownTimeout;
        while (inFlight > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }

        // Stop task worker and cron
        await app.stopWorker();
        app.stopCron();

        // Run user cleanup hook
        if (options.onShutdown) {
          await options.onShutdown();
        }
      } finally {
        cleanupListeners();
      }
    })();

    return shutdownPromise;
  };

  const onSigterm = () => handleShutdown();
  const onSigint = () => handleShutdown();
  const onAbort = () => handleShutdown();

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  if (options.signal) {
    options.signal.addEventListener("abort", onAbort);
  }

  // WebSocket upgrade handling (requires 'ws' package)
  if (app.wsRegistry.hasAnyHandlers()) {
    try {
      const wsMod = await import("ws");
      const { createWSConnection } = await import("./websocket.js");
      const { buildRequest } = await import("./request.js");
      const WSS = wsMod.WebSocketServer ?? (wsMod as any).default?.WebSocketServer;
      const wss = new WSS({ noServer: true });

      server.on("upgrade", async (req: IncomingMessage, socket: any, head: Buffer) => {
        try {
          const url = new URL(req.url ?? "/", `http://${host}:${port}`);
          const pathname = url.pathname;
          const handler = app.wsRegistry.getHandler(pathname);

          if (!handler) {
            socket.destroy();
            return;
          }

          // Build a CelsianRequest for upgrade auth hooks
          const webReq = nodeToWebRequest(req, url);
          const celsianReq = buildRequest(webReq, url, {});

          // Run onWsUpgrade hooks (global + per-handler) before accepting
          const allowed = await app.runWsUpgradeHooks(celsianReq, handler);
          if (!allowed) {
            app.log.info("WebSocket upgrade rejected", { path: pathname });
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }

          wss.handleUpgrade(req, socket, head, (ws: any) => {
            const conn = createWSConnection({
              send: (data: string | ArrayBuffer) => ws.send(data),
              close: (code?: number, reason?: string) => ws.close(code, reason),
            });

            app.wsRegistry.addConnection(pathname, conn);

            handler.open?.(conn, celsianReq);

            ws.on("error", (err: Error) => {
              app.log.error("WebSocket error", { path: pathname, connId: conn.id, error: err.message });
            });

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
              const msg = Buffer.isBuffer(data) ? data.toString() : data;
              handler.message?.(conn, msg as string | ArrayBuffer);
            });

            ws.on("close", (code: number, reason: Buffer) => {
              handler.close?.(conn, code, reason.toString());
              app.wsRegistry.removeConnection(pathname, conn);
            });
          });
        } catch (err) {
          app.log.error("WebSocket upgrade error", { error: (err as Error).message });
          socket.destroy();
        }
      });

      app.log.info("WebSocket upgrade handler enabled");
    } catch {
      // 'ws' package not installed — WebSocket disabled for Node.js
    }
  }

  return await new Promise<ServeResult>((resolve, reject) => {
    const onError = async (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      await app.stopWorker();
      app.stopCron();
      cleanupListeners();
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      const actualPort = boundPort();
      app.log.info(`Server running at http://${host}:${actualPort}`);
      console.log(`[celsian] Server running at http://${host}:${actualPort}`);
      options.onReady?.({ port: actualPort, host });
      resolve({
        close: () => handleShutdown(),
        port: actualPort,
        host,
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function serveBun(app: CelsianApp, port: number, host: string, options: ServeOptions): ServeResult {
  const server = (globalThis as any).Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
  });

  console.log(`[celsian] Server running at http://${host}:${port}`);
  options.onReady?.({ port, host });

  return {
    close: async () => {
      server.stop();
      if (options.onShutdown) await options.onShutdown();
    },
  };
}

function serveDeno(app: CelsianApp, port: number, host: string, options: ServeOptions): ServeResult {
  const controller = new AbortController();

  (globalThis as any).Deno.serve(
    {
      port,
      hostname: host,
      signal: options.signal ?? controller.signal,
      onListen() {
        console.log(`[celsian] Server running at http://${host}:${port}`);
        options.onReady?.({ port, host });
      },
    },
    app.fetch,
  );

  return {
    close: async () => {
      controller.abort();
      if (options.onShutdown) await options.onShutdown();
    },
  };
}

// ─── Conversion Helpers ───

/** Convert a Node.js IncomingMessage to a Web Standard Request. */
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

/**
 * Fast variant of nodeToWebRequest that constructs the Request with a
 * path-only URL (e.g., "/json?q=1"), enabling app.handle() to skip
 * full URL parsing. Falls back to full URL when the runtime requires it.
 */
function nodeToWebRequestFast(req: IncomingMessage, rawPath: string, baseUrl: string): Request {
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

  // Use full URL (required by Request constructor) but keep it minimal
  // by concatenating baseUrl + rawPath instead of calling new URL()
  return new Request(baseUrl + rawPath, {
    method,
    headers,
    body: hasBody ? (req as unknown as ReadableStream) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

/** Write a Web Standard Response back to a Node.js ServerResponse, preserving Set-Cookie headers. */
export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;

  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue; // handled below
    res.setHeader(key, value);
  }

  // BUG-3 fix: preserve multiple Set-Cookie headers (entries() collapses them)
  const cookies = (response.headers as any).getSetCookie?.() ?? [];
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
