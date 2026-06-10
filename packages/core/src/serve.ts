// @celsian/core — Built-in server (Node.js / Bun / Deno runtime detection)

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CelsianApp } from "./app.js";
import { getFastPayload } from "./fast-response.js";

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
  /** Authenticate WebSocket upgrade requests. Return false or throw to reject. */
  onUpgrade?: (request: Request, pathname: string) => boolean | Promise<boolean>;
  /**
   * Node-only: socket-level timeout for receiving the entire request, in ms
   * (`http.Server.requestTimeout`). Slowloris protection. Default: 60_000. Set 0 to disable.
   */
  requestTimeout?: number;
  /**
   * Node-only: socket-level timeout for receiving the complete request headers, in ms
   * (`http.Server.headersTimeout`). Slowloris protection. Default: 30_000. Set 0 to disable.
   */
  headersTimeout?: number;
}

/** Handle returned by `serve()` for programmatic shutdown. */
export interface ServeResult {
  close: () => Promise<void>;
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
  // Same default policy as loadConfig: HOST env, then 0.0.0.0 in production / localhost in dev
  let configHost = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "localhost");
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

  // Precedence (matches PORT): explicit option > env var > config file/default
  const port = options.port ?? parseInt(process.env.PORT || String(configPort), 10);
  const host = options.host ?? (process.env.HOST || configHost);

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

/** Shared teardown: stop worker, cron, and run user cleanup hook. */
async function teardownApp(app: CelsianApp, options: ServeOptions): Promise<void> {
  await app.stopWorker();
  app.stopCron();
  if (options.onShutdown) {
    await options.onShutdown();
  }
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

  // Pre-compute base URL string for Node.js request conversion (avoid per-request concatenation)
  const baseUrl = `http://${host}:${port}`;
  const hasStaticDir = !!options.staticDir;

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (shuttingDown) {
      res.statusCode = 503;
      res.end("Service Unavailable");
      return;
    }

    inFlight++;

    // Static files — only parse URL when staticDir is configured
    if (hasStaticDir) {
      const url = new URL(req.url ?? "/", baseUrl);
      const { resolve } = await import("node:path");
      const staticRoot = resolve(options.staticDir!);
      // Decode URI and normalize to prevent path traversal (e.g., /../../../etc/passwd).
      // Malformed percent-encoding (e.g. "/%ZZ") throws URIError — respond 400
      // rather than letting it crash the async server callback.
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch {
        res.statusCode = 400;
        res.end("Bad Request");
        inFlight--;
        return;
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
            inFlight--;
            return;
          }
        } catch {
          // Not a static file
        }
      }
    }

    // Build Web Request with raw path (let app.handle() do fast URL parsing)
    const webRequest = nodeToWebRequestFast(req, req.url ?? "/", baseUrl);

    try {
      const response = await app.handle(webRequest);
      await writeWebResponse(res, response);
    } catch (error) {
      console.error("[celsian] Unhandled error:", error);
      res.statusCode = 500;
      res.end("Internal Server Error");
    } finally {
      inFlight--;
    }
  });

  // Graceful shutdown
  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info("shutting down gracefully");

    // Stop accepting new connections
    server.close();

    // Wait for in-flight requests to drain
    const deadline = Date.now() + shutdownTimeout;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    await teardownApp(app, options);
  };

  process.on("SIGTERM", () => handleShutdown());
  process.on("SIGINT", () => handleShutdown());

  if (options.signal) {
    options.signal.addEventListener("abort", () => handleShutdown());
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
        const url = new URL(req.url ?? "/", `http://${host}:${port}`);
        const pathname = url.pathname;
        const handler = app.wsRegistry.getHandler(pathname);

        if (!handler) {
          socket.destroy();
          return;
        }

        // Authenticate upgrade requests via onUpgrade callback
        if (options.onUpgrade) {
          try {
            const webReq = nodeToWebRequest(req, url);
            const allowed = await options.onUpgrade(webReq, pathname);
            if (!allowed) {
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
              socket.destroy();
              return;
            }
          } catch {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }
        }

        wss.handleUpgrade(req, socket, head, (ws: any) => {
          const conn = createWSConnection({
            send: (data: string | ArrayBuffer) => ws.send(data),
            close: (code?: number, reason?: string) => ws.close(code, reason),
          });

          app.wsRegistry.addConnection(pathname, conn);

          // Build a CelsianRequest for the upgrade
          const webReq = nodeToWebRequest(req, url);
          const celsianReq = buildRequest(webReq, url, {});

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
      });

      app.log.info("WebSocket upgrade handler enabled");
    } catch {
      // 'ws' package not installed — WebSocket routes would silently 404 otherwise
      console.warn(
        "[celsian] WebSocket routes are registered but the 'ws' package is not installed — " +
          "WebSocket upgrades are disabled on Node.js. Install it with: npm install ws (or pnpm add ws).",
      );
    }
  }

  // Slowloris posture: cap how long a client may take to send headers / the full request.
  // 0 disables the corresponding timeout (Node semantics).
  server.requestTimeout = options.requestTimeout ?? 60_000;
  server.headersTimeout = options.headersTimeout ?? 30_000;

  // Resolve only after the server is actually listening (avoids ECONNREFUSED race),
  // and report the REAL bound address/port (port 0 → OS-assigned).
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundAddress = addr !== null && typeof addr === "object" ? addr.address : host;
  const boundPort = addr !== null && typeof addr === "object" ? addr.port : port;
  const boundFamily = addr !== null && typeof addr === "object" ? addr.family : "";
  const displayHost = boundAddress.includes(":") ? `[${boundAddress}]` : boundAddress;
  // When binding a hostname (e.g. "localhost"), show which family it resolved to.
  const familyNote =
    host !== boundAddress && boundFamily ? ` ("${host}" resolved to ${boundFamily} ${boundAddress})` : "";

  app.log.info(`Server running at http://${displayHost}:${boundPort}${familyNote}`);
  console.log(`[celsian] Server running at http://${displayHost}:${boundPort}${familyNote}`);

  // Loopback binds are unreachable from outside a container — almost always a
  // misconfiguration in production (Docker/Fly/Railway health checks fail).
  const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
  if (process.env.NODE_ENV === "production" && (LOOPBACK.has(boundAddress) || LOOPBACK.has(host))) {
    const note =
      `[celsian] note: production server is bound to loopback (${boundAddress}) — ` +
      "it will be unreachable from outside this machine/container. Set HOST=0.0.0.0 (or serve({ host: '0.0.0.0' })) to accept external traffic.";
    app.log.warn(note);
    console.warn(note);
  }

  options.onReady?.({ port: boundPort, host: boundAddress });

  return {
    close: () => handleShutdown(),
  };
}

function serveBun(app: CelsianApp, port: number, host: string, options: ServeOptions): ServeResult {
  warnWSUnsupported(app, "Bun");
  const server = (globalThis as any).Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
  });

  let shuttingDown = false;

  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info("shutting down gracefully");

    // Stop accepting new connections
    server.stop();

    await teardownApp(app, options);
  };

  process.on("SIGTERM", () => handleShutdown());
  process.on("SIGINT", () => handleShutdown());

  if (options.signal) {
    options.signal.addEventListener("abort", () => handleShutdown());
  }

  console.log(`[celsian] Server running at http://${host}:${port}`);
  options.onReady?.({ port, host });

  return {
    close: () => handleShutdown(),
  };
}

function serveDeno(app: CelsianApp, port: number, host: string, options: ServeOptions): ServeResult {
  warnWSUnsupported(app, "Deno");
  const controller = new AbortController();
  let shuttingDown = false;

  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info("shutting down gracefully");

    // Stop accepting new connections
    controller.abort();

    await teardownApp(app, options);
  };

  // Register signal listeners — wrap in try/catch since Deno permissions may not allow signal listening
  try {
    (globalThis as any).Deno.addSignalListener?.("SIGTERM", () => handleShutdown());
  } catch {
    // Signal listening not permitted
  }
  try {
    (globalThis as any).Deno.addSignalListener?.("SIGINT", () => handleShutdown());
  } catch {
    // Signal listening not permitted
  }

  if (options.signal) {
    options.signal.addEventListener("abort", () => handleShutdown());
  }

  (globalThis as any).Deno.serve(
    {
      port,
      hostname: host,
      signal: controller.signal,
      onListen() {
        console.log(`[celsian] Server running at http://${host}:${port}`);
        options.onReady?.({ port, host });
      },
    },
    app.fetch,
  );

  return {
    close: () => handleShutdown(),
  };
}

/** Warn at startup when `.ws()` handlers are registered on a runtime without upgrade wiring. */
function warnWSUnsupported(app: CelsianApp, runtime: string): void {
  if (app.wsRegistry.hasAnyHandlers()) {
    const hint =
      runtime === "Bun"
        ? " On Bun, serve WebSockets via the @celsian/adapter-bun handler (Bun.serve with native upgrades) instead of serve()."
        : "";
    console.warn(
      `[celsian] WebSocket routes are not supported on ${runtime} via serve() yet — ` +
        `registered .ws() handlers will not receive connections on this runtime.${hint}`,
    );
  }
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
  const raw = req.headers;
  // Common case: every header value is a string (Node coalesces duplicates,
  // leaving only set-cookie and a handful as arrays). Pass the plain record
  // straight to the Request constructor so it builds Headers once, instead of
  // building an intermediate Headers ourselves and having Request copy it again.
  let headers: Headers | Record<string, string> = raw as unknown as Record<string, string>;
  for (const k in raw) {
    if (Array.isArray(raw[k])) {
      // An array-valued header (e.g. set-cookie) — build Headers explicitly.
      const h = new Headers();
      for (const key in raw) {
        const value = raw[key];
        if (typeof value === "string") h.set(key, value);
        else if (Array.isArray(value)) for (const v of value) h.append(key, v);
      }
      headers = h;
      break;
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
  // Fast path: responses built by reply.json()/send()/html() or the auto-serializer
  // carry their already-serialized body + plain headers. Write them in a single
  // writeHead()+end() — no ReadableStream reader, no async drain, no second socket
  // write, and with an explicit Content-Length (avoids chunked encoding).
  const fast = getFastPayload(response);
  if (fast !== undefined) {
    const body = fast.body;
    const headers: Record<string, string | string[]> = { ...fast.headers };
    if (body !== null) {
      headers["content-length"] = String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength);
    }
    if (fast.cookies.length > 0) headers["set-cookie"] = fast.cookies;
    res.writeHead(fast.status, headers);
    if (body === null) res.end();
    else res.end(body);
    return;
  }

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
