// @celsian/core, Built-in server (Node.js / Bun / Deno runtime detection)

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { type CelsianApp, dispatchRequest, isStockHandle } from "./app.js";
import { HttpError } from "./errors.js";
import { getFastPayload, type Outgoing, peekHeaders, WireResponse } from "./fast-response.js";
import { readConfinedFile } from "./reply.js";
import { clearNodeBody, setNodeBody, setRemoteAddress } from "./request.js";
import { authorizeWSUpgrade, type WSAllowedOrigins, WSConnectionLimiter } from "./websocket.js";

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
   * Origins permitted to open a WebSocket. Accepts an origin, a list, `"*"`, or a
   * predicate. Default: same-origin only (the handshake's `Origin` must match `Host`).
   * WebSocket handshakes bypass CORS, so this is the CSWSH defence.
   */
  allowedOrigins?: WSAllowedOrigins;
  /**
   * Permit WebSocket handshakes with no `Origin` header (non-browser clients).
   * Default: `false`.
   */
  allowMissingOrigin?: boolean;
  /** Skip the app's root `onRequest` hooks on WebSocket handshakes. Default: `false` (hooks run). */
  skipUpgradeHooks?: boolean;
  /** Max WebSocket message size in bytes (default: 1 MiB; `ws` itself defaults to 100 MB). */
  maxPayload?: number;
  /** Max concurrent WebSocket connections per client IP (default: 64; 0 disables). */
  maxConnectionsPerIP?: number;
  /**
   * Install `unhandledRejection` / `uncaughtException` handlers that log through
   * the app logger and shut down gracefully. Default: `true`. Set `false` to
   * keep Node's default behaviour or install your own.
   */
  handleFatalErrors?: boolean;
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
  // Same default policy as loadConfig's defaultHost(): HOST env, then 0.0.0.0 in
  // production / the 127.0.0.1 loopback ADDRESS in dev. See defaultHost() for why
  // it is not the name "localhost".
  let configHost = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  try {
    const { loadConfig } = await import("./config.js");
    const config = await loadConfig();
    configPort = config.server?.port ?? configPort;
    configHost = config.server?.host ?? configHost;
  } catch (err) {
    // A genuinely broken celsian.config.* (syntax/runtime error, or a missing
    // import it depends on) must surface, silently binding defaults hides the
    // user's settings. loadConfig only throws ConfigLoadError for real failures;
    // an absent config file returns defaults without throwing.
    const { ConfigLoadError } = await import("./config.js");
    if (err instanceof ConfigLoadError) throw err;
    // Any other unexpected failure (e.g. importing config.js itself): keep defaults.
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

/**
 * True when the app has a real structured (JSON) logger.
 *
 * Uses the public `app.hasStructuredLogger()` accessor. An app-like object that
 * does not implement it keeps the human-readable console line.
 */
function hasStructuredLogger(app: CelsianApp): boolean {
  return typeof app.hasStructuredLogger === "function" && app.hasStructuredLogger();
}

/**
 * Print the startup/notice line to stdout only when the structured logger is off.
 * With `logger: true` this would otherwise inject a non-JSON line into a JSON stream.
 */
function announce(app: CelsianApp, message: string, level: "log" | "warn" = "log"): void {
  if (hasStructuredLogger(app)) return;
  if (level === "warn") console.warn(message);
  else console.log(message);
}

/**
 * A `listen()` failure that has already been put into plain language.
 *
 * The original Node error is kept as `cause` for debugging; the message is
 * what a developer reads. Marked as its own type so the fatal handler can
 * print the guidance on its own, without the "unhandledRejection" framing and
 * a Node-internal stack that make a busy port look like a framework crash.
 */
export class ServeListenError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ServeListenError";
  }
}

/**
 * Translate the handful of `listen()` failures a developer actually causes.
 *
 * A taken port is the single most common thing that happens on `npm run dev`,
 * and Node reports it as "listen EADDRINUSE: address already in use ::1:3000"
 * with a stack through `node:net`, which says nothing about what to do next.
 * Anything unrecognised is passed through untouched rather than being
 * paraphrased into something less accurate.
 */
function explainListenError(error: unknown, host: string, port: number): unknown {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const where = `${host.includes(":") ? `[${host}]` : host}:${port}`;

  if (code === "EADDRINUSE") {
    // Suggest a concrete free-looking port rather than a literal, so the hint
    // never reads "port 3001 is in use, try PORT=3001".
    const suggestion = port + 1;
    return new ServeListenError(
      `Port ${port} is already in use (tried to bind ${where}). Stop whatever is using it, or pick another port with PORT=${suggestion} (or serve(app, { port: ${suggestion} })).`,
      error,
    );
  }
  if (code === "EACCES") {
    return new ServeListenError(
      `Port ${port} needs elevated privileges (tried to bind ${where}). Ports below 1024 are restricted, so use PORT=3000 in development and put a proxy in front in production.`,
      error,
    );
  }
  if (code === "EADDRNOTAVAIL") {
    return new ServeListenError(
      `Host ${host} is not an address on this machine (tried to bind ${where}). Set HOST to an address this machine owns, or to 0.0.0.0 for every interface.`,
      error,
    );
  }
  return error;
}

/**
 * Install `unhandledRejection` / `uncaughtException` handlers.
 *
 * Node's default on an unhandled rejection is to crash immediately, dropping
 * in-flight requests. These handlers log the failure with full context, drain,
 * and then exit non-zero, they never swallow the error, because a silently
 * swallowed rejection leaves the process in an unknown state.
 */
function installFatalErrorHandlers(app: CelsianApp, options: ServeOptions, shutdown: () => Promise<void>): () => void {
  const noop = () => {};
  if (options.handleFatalErrors === false) return noop;
  // Deno without the Node compatibility layer has no process.on.
  if (typeof process === "undefined" || typeof process.on !== "function") return noop;

  let handling = false;
  const fatal = (kind: "unhandledRejection" | "uncaughtException", error: unknown) => {
    if (handling) return;
    handling = true;

    const err = error instanceof Error ? error : new Error(String(error));
    // A startup failure we already explained is a one-line fix, not a crash.
    // `serve(app)` is normally called without being awaited, so it arrives here
    // as an unhandled rejection, and the usual framing plus a node:net stack
    // makes "port 3000 is busy" look like the framework fell over.
    const explained = err instanceof ServeListenError;
    app.log.fatal(explained ? err.message : `${kind}, shutting down`, {
      type: kind,
      error: err.message,
      stack: err.stack,
    });
    // Always surface to stderr: a fatal must never be invisible, even with a noop logger.
    if (explained) console.error(`[celsian] ${err.message}`);
    else console.error(`[celsian] ${kind}, shutting down:`, err);

    void shutdown()
      .catch((shutdownErr) => {
        console.error("[celsian] error during fatal shutdown:", shutdownErr);
      })
      .finally(() => {
        process.exitCode = 1;
        process.exit(1);
      });
  };

  const onRejection = (reason: unknown) => fatal("unhandledRejection", reason);
  const onException = (error: unknown) => fatal("uncaughtException", error);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  // Returned so shutdown can detach them, long-lived test processes (and any
  // caller that starts several servers) would otherwise accumulate listeners.
  return () => {
    process.removeListener("unhandledRejection", onRejection);
    process.removeListener("uncaughtException", onException);
  };
}

/** Register SIGTERM/SIGINT shutdown listeners; returns a disposer that detaches them. */
function installSignalHandlers(handleShutdown: () => void): () => void {
  const onSignal = () => handleShutdown();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return () => {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  };
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
  const sockets = new Set<Socket>();
  const webSockets = new Set<{
    close: (code?: number, reason?: string) => void;
    terminate?: () => void;
    readyState?: number;
  }>();
  const pendingUpgradeSockets = new Set<Socket>();

  // Cache the listener authority; update the actual address after binding port 0.
  let baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const hasStaticDir = !!options.staticDir;

  /**
   * Serve `req` from `staticDir` when it names a file there. Resolves to true
   * once the file has been written, false when the app should answer instead.
   */
  const serveStatic = async (res: ServerResponse, requestUrl: string | URL): Promise<boolean> => {
    const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
    const { resolve } = await import("node:path");
    const staticRoot = resolve(options.staticDir!);
    // Decode URI and normalize to prevent path traversal (e.g., /../../../etc/passwd).
    // Malformed percent-encoding (e.g. "/%ZZ") throws URIError, respond 400
    // rather than letting it crash the async server callback.
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, "Bad Request");
    }
    // `join` first, then confine: a URL path is always absolute ("/app.js"),
    // and handing that straight to `resolve(root, path)` would let it replace
    // the root outright, so every request would look like an escape.
    const filePath = resolve(join(staticRoot, decodedPath));
    // Containment is delegated to the SAME helper reply.sendFile() uses, so
    // this second file-serving path cannot drift from it again. It was
    // lexical-only here (a `startsWith` on the resolved path) while sendFile
    // had already been hardened with realpath() + O_NOFOLLOW, which meant a
    // symlink planted inside staticDir served whatever it pointed at:
    // `GET /avatar.png` returning the contents of `.env` with a 200.
    //
    // A rejection falls through to the app handler rather than answering 403,
    // matching what the lexical check already did for traversal attempts, so
    // the static layer still never reports on files outside its own root.
    const file = await readConfinedFile(filePath, { root: staticRoot });
    if (!file.ok) return false;
    // Extension comes from the requested path, not the realpath()-resolved
    // one, so the content-type does not change under the client's feet.
    const ext = extname(filePath);
    res.setHeader("content-type", MIME_TYPES[ext] ?? "application/octet-stream");
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.end(file.data);
    return true;
  };

  /** Runs once per request, however it ended. */
  const done = (req: IncomingMessage): void => {
    endTransportSignal(req);
    inFlight--;
  };

  /** Answer for a request that failed before or while it was written. */
  const fail = (res: ServerResponse, error: unknown): void => {
    if (res.destroyed) return;
    const badRequest = error instanceof HttpError && error.statusCode === 400;
    if (!badRequest) console.error("[celsian] Unhandled error:", error);
    if (res.headersSent) res.destroy();
    else {
      try {
        res.statusCode = badRequest ? 400 : 500;
        res.setHeader("connection", "close");
        res.end(badRequest ? "Bad Request" : "Internal Server Error");
      } catch {
        res.destroy();
      }
    }
  };

  const failed = (req: IncomingMessage, res: ServerResponse, error: unknown): void => {
    fail(res, error);
    done(req);
  };

  /**
   * Write the app's answer and finish the request. A fast response is written
   * and finished before this returns; a body stream is drained first.
   */
  const write = (req: IncomingMessage, res: ServerResponse, out: Outgoing): void => {
    let draining: Promise<void> | undefined;
    try {
      draining = writeOutgoing(res, out);
    } catch (error) {
      failed(req, res, error);
      return;
    }
    if (draining === undefined) done(req);
    else
      draining.then(
        () => done(req),
        (error) => failed(req, res, error),
      );
  };

  /**
   * Hand `req` to the app, write its answer and finish the request. All of it
   * happens before this returns when the app answers synchronously with a fast
   * response. An answer that is still pending is waited on once: the same
   * callback writes it and finishes the request.
   */
  const answer = (req: IncomingMessage, res: ServerResponse, requestUrl: string | URL): void => {
    let response: Outgoing | Promise<Outgoing>;
    try {
      // An app whose `handle` was replaced or overridden keeps going through
      // it, and that code is handed the Request itself. It may rebuild it
      // (`handle(new Request(request, { headers }))`), and a rebuilt Request
      // follows the signal the original holds internally, not the one its
      // `signal` property reports. So such an app gets a Request built with its
      // signal, as every Request was before signals became lazy.
      //
      // `app.handle` is read once, and what was read is what is called, with
      // the app as `this`, as `await app.handle(request)` did: an accessor may
      // answer differently each time it is read.
      const handle = app.handle;
      const stock = isStockHandle(handle);

      // Build Web Request with raw path (let the app do fast URL parsing)
      let webRequest: Request;
      try {
        webRequest = nodeToWebRequestFast(req, requestUrl, !stock);
      } catch {
        throw new HttpError(400, "Bad Request");
      }

      // The app's internal entry point can answer without a promise, and with a
      // fast response whose final headers are still beside it, which
      // writeOutgoing sends as is. A replaced handle is answered the way
      // `await app.handle()` answers it: what it returns may be a promise from
      // another realm (`instanceof Promise` is false for one), another
      // thenable, or a Response returned without a promise at all.
      response = stock ? dispatchRequest(app, webRequest) : Promise.resolve(Reflect.apply(handle, app, [webRequest]));
    } catch (error) {
      failed(req, res, error);
      return;
    }
    if (response instanceof Promise) {
      response.then(
        (settled) => write(req, res, settled),
        (error) => failed(req, res, error),
      );
    } else {
      write(req, res, response);
    }
  };

  // Not an async function: a request the app answers synchronously is written
  // and finished right here, without a promise for the callback itself.
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (shuttingDown) {
      res.statusCode = 503;
      res.end("Service Unavailable");
      return;
    }

    inFlight++;

    let requestUrl: string | URL;
    try {
      requestUrl = nodeRequestUrl(req.url ?? "/", baseUrl);
    } catch (error) {
      failed(req, res, error);
      return;
    }
    // Static files, only parse URL when staticDir is configured
    if (!hasStaticDir) {
      answer(req, res, requestUrl);
      return;
    }
    let serving: Promise<boolean>;
    try {
      serving = serveStatic(res, requestUrl);
    } catch (error) {
      failed(req, res, error);
      return;
    }
    serving.then(
      (served) => {
        if (served) done(req);
        else answer(req, res, requestUrl);
      },
      (error) => failed(req, res, error),
    );
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  // Graceful shutdown
  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info("shutting down gracefully");

    // Stop accepting new connections. The callback fires only after Node has
    // closed every tracked HTTP connection, including responses still flushing
    // to slow clients after the Celsian handler has returned.
    let serverClosed = false;
    const serverClosedPromise = new Promise<void>((resolve) => {
      server.close(() => {
        serverClosed = true;
        resolve();
      });
    });
    server.closeIdleConnections?.();

    for (const ws of webSockets) {
      try {
        ws.close(1001, "Server shutting down");
      } catch {
        webSockets.delete(ws);
      }
    }

    // Wait until the actual graceful deadline for HTTP sockets, in-flight
    // handlers, and upgraded WebSockets to drain. A handler can finish before
    // Node has flushed its response to the client, so `inFlight === 0` alone is
    // not proof that it is safe to destroy the socket.
    const deadline = Date.now() + shutdownTimeout;
    while (
      (inFlight > 0 || webSockets.size > 0 || pendingUpgradeSockets.size > 0 || sockets.size > 0 || !serverClosed) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }

    if (inFlight > 0 || webSockets.size > 0 || pendingUpgradeSockets.size > 0 || sockets.size > 0 || !serverClosed) {
      for (const ws of webSockets) {
        try {
          ws.terminate?.();
        } catch {
          // Socket may already be closing.
        }
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.race([serverClosedPromise, new Promise((resolve) => setTimeout(resolve, 50))]);
    }

    await teardownApp(app, options);
    detachSignals();
    detachFatal();
  };

  const detachSignals = installSignalHandlers(handleShutdown);
  const detachFatal = installFatalErrorHandlers(app, options, handleShutdown);

  if (options.signal) {
    options.signal.addEventListener("abort", () => handleShutdown());
  }

  // WebSocket upgrade handling (requires the optional peer dependency 'ws')
  if (app.wsRegistry.hasAnyHandlers()) {
    try {
      // Resolve the specifier indirectly so bundlers (esbuild/Vite/webpack) do
      // not follow it. `ws` is an OPTIONAL peer dependency resolved at runtime
      // on Node; a literal import() would drag its node: builtins into edge
      // bundles of @celsian/core that never serve WebSockets.
      const wsSpecifier = "ws";
      const wsMod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ wsSpecifier)) as {
        WebSocketServer?: new (options: Record<string, unknown>) => any;
        default?: { WebSocketServer?: new (options: Record<string, unknown>) => any };
      };
      const { createWSConnection } = await import("./websocket.js");
      const { buildRequest, resolveClientIp, resolveEffectiveUrl } = await import("./request.js");
      const WSS = wsMod.WebSocketServer ?? (wsMod as any).default?.WebSocketServer;
      // `ws` defaults maxPayload to 100 MB, far too generous for a default.
      const wss = new WSS({ noServer: true, maxPayload: options.maxPayload ?? 1024 * 1024 });
      const limiter = new WSConnectionLimiter(options.maxConnectionsPerIP ?? 64);

      server.on("upgrade", async (req: IncomingMessage, socket: any, head: Buffer) => {
        if (shuttingDown) {
          socket.destroy();
          return;
        }
        pendingUpgradeSockets.add(socket);
        let upgraded = false;
        try {
          const requestUrl = nodeRequestUrl(req.url ?? "/", baseUrl);
          const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
          const pathname = url.pathname;
          const handler = app.wsRegistry.getHandler(pathname);

          if (!handler) {
            socket.destroy();
            return;
          }

          // Gate the handshake: Origin allow-list, onUpgrade callback, then the
          // app's root onRequest hooks (auth guards, rate limiters). WebSocket
          // handshakes are exempt from CORS, so without this a cross-site page can
          // open an authenticated socket with the victim's cookies.
          let webReq: Request;
          try {
            webReq = nodeToWebRequest(req, url);
            if (typeof requestUrl !== "string") webReq.headers.set("host", url.host);
          } catch {
            throw new HttpError(400, "Bad Request");
          }
          const decision = await authorizeWSUpgrade(app, webReq, pathname, {
            allowedOrigins: options.allowedOrigins,
            allowMissingOrigin: options.allowMissingOrigin,
            onUpgrade: options.onUpgrade,
            runRequestHooks: options.skipUpgradeHooks !== true,
          });

          if (shuttingDown || socket.destroyed) {
            socket.destroy();
            return;
          }

          if (!decision.allowed) {
            app.log.warn("WebSocket upgrade rejected", {
              path: pathname,
              status: decision.status,
              reason: decision.reason,
            });
            socket.write(`HTTP/1.1 ${decision.status} ${decision.status === 403 ? "Forbidden" : "Rejected"}\r\n\r\n`);
            socket.destroy();
            return;
          }

          const clientIp: string = req.socket?.remoteAddress ?? "unknown";
          if (!limiter.acquire(clientIp)) {
            app.log.warn("WebSocket upgrade rejected: per-IP connection cap reached", { path: pathname, ip: clientIp });
            socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
            socket.destroy();
            return;
          }
          let released = false;
          const releaseSlot = () => {
            if (released) return;
            released = true;
            limiter.release(clientIp);
          };
          socket.once("close", releaseSlot);

          wss.handleUpgrade(req, socket, head, (ws: any) => {
            upgraded = true;
            webSockets.add(ws);
            ws.once("close", () => webSockets.delete(ws));
            const conn = createWSConnection({
              send: (data: string | ArrayBuffer) => ws.send(data),
              close: (code?: number, reason?: string) => ws.close(code, reason),
            });

            app.wsRegistry.addConnection(pathname, conn);
            ws.on("close", (code: number, reason: Buffer) => {
              app.wsRegistry.removeConnection(pathname, conn);
              releaseSlot();
              handler.close?.(conn, code, reason.toString());
            });

            // Build a CelsianRequest for the upgrade (reuses the gated Request).
            //
            // `url` above is composed from the address the server BOUND to, which
            // is `0.0.0.0` in production, so handing it straight to the handler
            // meant a WebSocket handler saw `http://0.0.0.0:3000/chat` instead of
            // the host the client addressed. That breaks any handler that routes
            // on host (multi-tenant apps especially). The upgrade GATE already
            // resolves this itself, so this was never an auth bypass, only a
            // wrong value delivered to application code.
            const effectiveUrl = new URL(resolveEffectiveUrl(webReq.url, webReq.headers, app.getForwardedTrust()));
            const celsianReq = buildRequest(webReq, effectiveUrl, {});
            celsianReq.ip = resolveClientIp(webReq, app.getForwardedTrust().clientIp);

            ws.on("error", (err: Error) => {
              app.log.error("WebSocket error", { path: pathname, connId: conn.id, error: err.message });
            });

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
              const msg = Buffer.isBuffer(data) ? data.toString() : data;
              handler.message?.(conn, msg as string | ArrayBuffer);
            });

            handler.open?.(conn, celsianReq);
          });
        } catch (error) {
          if (!socket.destroyed) {
            if (upgraded) {
              socket.destroy();
              return;
            }
            try {
              const status =
                error instanceof HttpError && error.statusCode === 400
                  ? "400 Bad Request"
                  : "500 Internal Server Error";
              socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            } catch {
              socket.destroy();
            }
          }
        } finally {
          requestSignalCleanup.get(req)?.();
          pendingUpgradeSockets.delete(socket);
        }
      });

      app.log.info("WebSocket upgrade handler enabled");
    } catch {
      // 'ws' package not installed, WebSocket routes would silently 404 otherwise.
      // It is declared as an OPTIONAL peer dependency of @celsian/core so the
      // requirement is discoverable without adding a runtime dep to core.
      console.warn(
        "[celsian] WebSocket routes are registered but the optional peer dependency 'ws' is not installed, " +
          "WebSocket upgrades are disabled on Node.js. Install it with one of:\n" +
          "  npm install ws\n" +
          "  pnpm add ws\n" +
          "  yarn add ws",
      );
    }
  }

  // Slowloris posture: cap how long a client may take to send headers / the full request.
  // 0 disables the corresponding timeout (Node semantics).
  server.requestTimeout = options.requestTimeout ?? 60_000;
  server.headersTimeout = options.headersTimeout ?? 30_000;

  // Resolve only after the server is actually listening (avoids ECONNREFUSED race),
  // and report the REAL bound address/port (port 0 → OS-assigned).
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    throw explainListenError(err, host, port);
  }

  const addr = server.address();
  const boundAddress = addr !== null && typeof addr === "object" ? addr.address : host;
  const boundPort = addr !== null && typeof addr === "object" ? addr.port : port;
  const boundFamily = addr !== null && typeof addr === "object" ? addr.family : "";
  const displayHost = boundAddress.includes(":") ? `[${boundAddress}]` : boundAddress;
  baseUrl = `http://${displayHost}:${boundPort}`;
  // When binding a hostname (e.g. "localhost"), show which family it resolved to.
  const familyNote =
    host !== boundAddress && boundFamily ? ` ("${host}" resolved to ${boundFamily} ${boundAddress})` : "";

  app.log.info(`Server running at http://${displayHost}:${boundPort}${familyNote}`);
  // Only echo the human-readable line when there is no structured logger, so a
  // JSON log stream never gets a stray plain-text line on boot.
  announce(app, `[celsian] Server running at http://${displayHost}:${boundPort}${familyNote}`);

  // Loopback binds are unreachable from outside a container, almost always a
  // misconfiguration in production (Docker/Fly/Railway health checks fail).
  const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
  if (process.env.NODE_ENV === "production" && (LOOPBACK.has(boundAddress) || LOOPBACK.has(host))) {
    const note =
      `[celsian] note: production server is bound to loopback (${boundAddress}), ` +
      "it will be unreachable from outside this machine/container. Set HOST=0.0.0.0 (or serve({ host: '0.0.0.0' })) to accept external traffic.";
    app.log.warn(note);
    announce(app, note, "warn");
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
    detachSignals();
    detachFatal();
  };

  const detachSignals = installSignalHandlers(handleShutdown);
  const detachFatal = installFatalErrorHandlers(app, options, handleShutdown);

  if (options.signal) {
    options.signal.addEventListener("abort", () => handleShutdown());
  }

  app.log.info(`Server running at http://${host}:${port}`);
  announce(app, `[celsian] Server running at http://${host}:${port}`);
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
    detachFatal();
  };

  // Register signal listeners, wrap in try/catch since Deno permissions may not allow signal listening
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

  const detachFatal = installFatalErrorHandlers(app, options, handleShutdown);

  if (options.signal) {
    options.signal.addEventListener("abort", () => handleShutdown());
  }

  (globalThis as any).Deno.serve(
    {
      port,
      hostname: host,
      signal: controller.signal,
      onListen() {
        app.log.info(`Server running at http://${host}:${port}`);
        announce(app, `[celsian] Server running at http://${host}:${port}`);
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
      `[celsian] WebSocket routes are not supported on ${runtime} via serve() yet, ` +
        `registered .ws() handlers will not receive connections on this runtime.${hint}`,
    );
  }
}

// ─── Conversion Helpers ───

const requestSignalCleanup = new WeakMap<IncomingMessage, () => void>();

/** Preserve the origin-form hot path; validate and parse only absolute-form. */
function nodeRequestUrl(target: string, baseUrl: string): string | URL {
  // Leading // is still an origin-form path, never a network-path authority.
  if (target.charCodeAt(0) === 47 /* '/' */) return baseUrl + target;
  const authority = /^https?:\/\/([^/?#]+)/i.exec(target)?.[1];
  if (!authority || authority.includes("@") || target.includes("#") || target.includes("\\")) {
    throw new HttpError(400, "Bad Request");
  }
  try {
    const url = new URL(target);
    if (!url.hostname || url.username || url.password) throw new HttpError(400, "Bad Request");
    return url;
  } catch {
    throw new HttpError(400, "Bad Request");
  }
}

/** IncomingMessage.close also fires after a normal body; watch socket closure instead. */
function nodeRequestSignal(req: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  const socket = req.socket;
  const cleanup = () => {
    req.off("aborted", abort);
    socket.off("close", abort);
    requestSignalCleanup.delete(req);
  };
  const abort = () => {
    controller.abort();
    cleanup();
  };
  requestSignalCleanup.get(req)?.();
  requestSignalCleanup.set(req, cleanup);
  req.once("aborted", abort);
  socket.once("close", abort);
  if (req.aborted || socket.destroyed) abort();
  return controller.signal;
}

// ─── The transport signal of a request core's own server builds ───
//
// `request.signal` has to abort when the client goes away. Wiring that up
// costs a controller, two listeners and their closures, and handing the signal
// to `new Request()` costs considerably more: the Request builds a second
// controller to follow the first, with a WeakRef, a FinalizationRegistry entry
// and (in Node 22) an error object thrown and caught while it sizes the
// listener list. Most handlers never read `request.signal`.
//
// So the Request is built without a signal, and reading `signal` on it builds
// the transport signal then. A signal read while the request is in flight is
// the one `nodeRequestSignal` has always produced. One first read after the
// request was answered gets a signal in the state the eager one would be in by
// then: aborted if the request was aborted before it was answered, otherwise
// not aborted and never going to be.
//
// What the property cannot reach is the signal a Request holds internally,
// which is the one `new Request(request, init)` and `fetch(request)` follow.
// A lazy Request's internal signal never aborts. Only core sees such a
// Request, with two exceptions that are therefore built with a real signal:
// the Request handed to a replaced `app.handle`, and any clone.

/** The transport signal of a Node request, once something has read it. On the IncomingMessage, so a clone shares it. */
const TRANSPORT_SIGNAL = Symbol("celsian.transportSignal");
/** Set on an IncomingMessage once its request was answered: whether it had been aborted by then. */
const ABORTED_WHEN_ANSWERED = Symbol("celsian.abortedWhenAnswered");
/** The IncomingMessage a {@link NodeRequest} was built from. */
const INCOMING = Symbol("celsian.incomingMessage");

interface TrackedIncoming extends IncomingMessage {
  [TRANSPORT_SIGNAL]?: AbortSignal;
  [ABORTED_WHEN_ANSWERED]?: boolean;
}

function transportSignal(req: TrackedIncoming): AbortSignal {
  let signal = req[TRANSPORT_SIGNAL];
  if (signal === undefined) {
    const abortedWhenAnswered = req[ABORTED_WHEN_ANSWERED];
    if (abortedWhenAnswered === undefined) {
      signal = nodeRequestSignal(req);
    } else {
      const controller = new AbortController();
      if (abortedWhenAnswered) controller.abort();
      signal = controller.signal;
    }
    req[TRANSPORT_SIGNAL] = signal;
  }
  return signal;
}

/** The request was answered: stop following the socket, and remember how it stood for a late first read. */
function endTransportSignal(req: TrackedIncoming): void {
  requestSignalCleanup.get(req)?.();
  req[ABORTED_WHEN_ANSWERED] = req.aborted || req.socket.destroyed;
}

/** The `Request` this module loaded with, which {@link NodeRequest} extends. */
const BaseRequest = Request;

/** A Request built from a Node request. Identical to a plain one except that `signal` is built on first read. */
class NodeRequest extends BaseRequest {
  declare [INCOMING]: TrackedIncoming;

  /** A clone follows the same connection, so it keeps the same transport signal. */
  override clone(): Request {
    // Cloning tees the body stream, and both halves read from the Node stream
    // through it. The body parser must then do the same.
    clearNodeBody(this);
    // A clone leaves core: `request.clone()` in a handler returns it. So it is
    // rebuilt around the transport signal, which makes that the signal it
    // holds internally as well as the one it reports. A Request made from the
    // clone (`new Request(clone, init)`, `fetch(clone)`) then still aborts when
    // the client goes away. Costs a second Request, on clone() only.
    const incoming = this[INCOMING];
    const copy = new NodeRequest(super.clone(), { signal: transportSignal(incoming) });
    copy[INCOMING] = incoming;
    return copy;
  }
}

// On the prototype, so building a NodeRequest costs nothing extra. Defined
// here rather than in the class body because `Request` declares `signal` as a
// property, which a class may not override with an accessor.
Object.defineProperty(NodeRequest.prototype, "signal", {
  configurable: true,
  enumerable: true,
  get(this: NodeRequest): AbortSignal {
    return transportSignal(this[INCOMING]);
  },
});

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

  const request = new Request(url.toString(), {
    method,
    headers,
    body: hasBody ? (req as unknown as ReadableStream) : undefined,
    duplex: hasBody ? "half" : undefined,
    signal: nodeRequestSignal(req),
  });
  return setRemoteAddress(request, req.socket?.remoteAddress);
}

/**
 * Fast variant of nodeToWebRequest using a prebuilt URL string for origin-form.
 * Absolute-form uses its parsed authority instead of the received Host header.
 *
 * `eagerSignal` builds the transport signal now and gives it to the Request,
 * for a Request that code outside core will hold (see {@link NodeRequest}).
 */
function nodeToWebRequestFast(req: IncomingMessage, url: string | URL, eagerSignal: boolean): Request {
  const raw = req.headers;
  // Common case: every header value is a string (Node coalesces duplicates,
  // leaving only set-cookie and a handful as arrays). Pass the plain record
  // straight to the Request constructor so it builds Headers once, instead of
  // building an intermediate Headers ourselves and having Request copy it again.
  let headers: Headers | Record<string, string> = raw as unknown as Record<string, string>;
  for (const k in raw) {
    if (Array.isArray(raw[k])) {
      // An array-valued header (e.g. set-cookie), build Headers explicitly.
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

  // Absolute-form carries its own authority; the received Host must not
  // replace it when the app resolves the effective URL. Origin-form is unchanged.
  if (typeof url !== "string") {
    headers = new Headers(headers);
    headers.set("host", url.host);
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  // Origin-form's full URL was built by concatenation, without a URL allocation.
  const body = hasBody ? (req as unknown as ReadableStream) : undefined;
  const duplex = hasBody ? "half" : undefined;
  let request: Request;
  if (Request === BaseRequest) {
    // Normally no `signal` is passed: NodeRequest builds it when it is first read.
    const lazy = eagerSignal
      ? new NodeRequest(url, { method, headers, body, duplex, signal: transportSignal(req) })
      : new NodeRequest(url, { method, headers, body, duplex });
    lazy[INCOMING] = req;
    // Lets the body parser read `req` itself instead of the web stream around it.
    if (hasBody) setNodeBody(lazy, req);
    request = lazy;
  } else {
    // The global Request has been replaced since this module loaded (a
    // polyfill, an instrumentation wrapper). NodeRequest extends the original,
    // so build the request the replacement's own way, signal included.
    request = new Request(url, { method, headers, body, duplex, signal: nodeRequestSignal(req) });
  }
  return setRemoteAddress(request, req.socket?.remoteAddress);
}

/** Write a Web Standard Response back to a Node.js ServerResponse, preserving Set-Cookie headers. */
export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  try {
    await writeOutgoing(res, response);
  } finally {
    requestSignalCleanup.get(res.req)?.();
  }
}

/**
 * {@link writeWebResponse} for what the app's internal entry point returns.
 * Returns `undefined` when the response was written in full before this
 * returned (any fast response), a promise while a body stream is being drained.
 */
function writeOutgoing(res: ServerResponse, out: Outgoing): Promise<void> | undefined {
  if (out instanceof WireResponse) {
    if (res.destroyed) {
      void out.source.body?.cancel().catch(() => {});
      return undefined;
    }
    writeFast(res, out.status, out.body, out.headers, out.cookies);
    return undefined;
  }
  if (res.destroyed) {
    void out.body?.cancel().catch(() => {});
    return undefined;
  }
  // Fast path: responses built by reply.json()/send()/html() or the auto-serializer
  // carry their already-serialized body + plain headers. Write them in a single
  // writeHead()+end(), no ReadableStream reader, no async drain, no second socket
  // write, and with an explicit Content-Length (avoids chunked encoding).
  const fast = getFastPayload(out);
  if (fast === undefined) return drainResponse(res, out);
  if (!fast.headersExposed) {
    writeFast(res, fast.status, fast.body, fast.headers, fast.cookies);
    return undefined;
  }
  // Something read `response.headers` after the Response was built, so it
  // may have added, replaced or removed a header. The snapshot can no
  // longer be trusted; take the headers the Response actually carries,
  // which is what inject() and every other runtime report. Still a single
  // writeHead()+end(): only the source of the headers changes.
  let body = fast.body;
  const headers: Record<string, string | string[]> = {};
  const live = peekHeaders(out);
  let nonAscii = false;
  for (const [key, value] of live) {
    // Iteration yields each Set-Cookie on its own (and so checks each one
    // here); they are collected below.
    if (key !== "set-cookie") headers[key] = value;
    if (!nonAscii && NON_ASCII.test(value)) nonAscii = true;
  }
  if (nonAscii && typeof body === "string") body = Buffer.from(body);
  const cookies = live.getSetCookie?.() ?? [];
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  sendWhole(res, fast.status, headers, body);
  return undefined;
}

/** A Transfer-Encoding whose last coding is chunked, the one that delimits a body (RFC 9112 section 6.3). */
const CHUNKED_LAST = /(?:^|,)[\t ]*chunked[\t ]*$/i;

/**
 * Make `headers` say how the body that follows is delimited, and nothing that
 * contradicts it. `headers` is the writer's own copy and is changed in place.
 *
 * - A Transfer-Encoding set on the reply frames the body: Node then encodes it
 *   in chunks when the coding is chunked. A Content-Length beside it is never
 *   sent, whoever set it (RFC 9112 section 6.1; Node's client refuses such a
 *   response). When the last coding is not chunked, only closing the
 *   connection ends the body, so the connection is closed after it.
 * - Otherwise a body is sent with the Content-Length of its bytes, replacing
 *   any value set on the reply.
 * - Otherwise there is no body. Where one would be allowed, Node then sends
 *   `Content-Length: 0`, so a value set on the reply is dropped: it would make
 *   the client wait for bytes that never come. A HEAD response and a 304 keep
 *   it, since there it describes the content a GET would get.
 * - A 204 carries neither header (RFC 9110 section 8.6, RFC 9112 section 6.1).
 *
 * 1xx statuses never get here: a Response cannot be built with one.
 */
function frame(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | string[]>,
  body: string | Uint8Array | null,
): void {
  if (status === 204) {
    if (headers["content-length"] !== undefined) delete headers["content-length"];
    if (headers["transfer-encoding"] !== undefined) delete headers["transfer-encoding"];
    return;
  }
  const codings = headers["transfer-encoding"];
  if (codings !== undefined) {
    if (headers["content-length"] !== undefined) delete headers["content-length"];
    if (status !== 304 && res.req?.method !== "HEAD" && !CHUNKED_LAST.test(String(codings))) {
      headers.connection = "close";
    }
    return;
  }
  if (body !== null) headers["content-length"] = contentLengthOf(body);
  else if (headers["content-length"] !== undefined && status !== 304 && res.req?.method !== "HEAD") {
    delete headers["content-length"];
  }
}

/**
 * Send a status, its final headers and an already-serialized body in one go,
 * framed by {@link frame}.
 *
 * With a body that is `writeHead()+end(body)`. Without one the framing is
 * left to Node: `writeHead()` fixes the header block before Node knows the
 * response is empty, so a 200 with no body went out as
 * `Transfer-Encoding: chunked` and a zero-length chunk. Headers set one by one
 * and then `end()` give `Content-Length: 0` instead, and nothing at all where
 * no body is allowed (204, 304, a HEAD request).
 */
function sendWhole(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | string[]>,
  body: string | Uint8Array | null,
): void {
  frame(res, status, headers, body);
  if (body === null) {
    res.statusCode = status;
    for (const key in headers) res.setHeader(key, headers[key] as string | string[]);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function contentLengthOf(body: string | Uint8Array): string {
  return String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength);
}

// ─── Header bytes ───
//
// A header value is a byte string: `reply.header("x-name", "café")` means the
// bytes 63 61 66 E9, which is what `Headers` stores, what inject() reports and
// what Node writes for a header block sent on its own. But when the first
// body chunk is a string, Node joins the header block and that chunk into one
// string and writes it in the BODY's encoding, UTF-8, so the same header goes
// out as 63 61 66 C3 A9. That is the single write the fast path exists for.
//
// So a string body is turned into bytes first whenever a header value holds
// anything outside ASCII. Node then writes the header block as latin-1 and the
// body after it, still in one go (the socket is corked across end()). Checking
// costs one pass over the header values, which Node makes as well to validate
// them, and nothing is allocated when they are ASCII, which is nearly always.

/** A character that makes a header value's UTF-8 bytes differ from its latin-1 bytes. */
const NON_ASCII = /[\u0080-\uffff]/;

/** True when a value in `headers` holds a character outside ASCII. */
function hasNonAsciiValue(headers: Record<string, string>): boolean {
  for (const key in headers) {
    if (NON_ASCII.test(headers[key] as string)) return true;
  }
  return false;
}

/** {@link hasNonAsciiValue} for a list of Set-Cookie values. */
function hasNonAsciiCookie(cookies: readonly string[]): boolean {
  for (let i = 0; i < cookies.length; i++) {
    if (NON_ASCII.test(cookies[i] as string)) return true;
  }
  return false;
}

/**
 * Write an already-serialized body with its plain headers in one go (see
 * {@link sendWhole}). `headers` is copied, never modified.
 */
function writeFast(
  res: ServerResponse,
  status: number,
  body: string | Uint8Array | null,
  plainHeaders: Record<string, string>,
  cookies: readonly string[],
): void {
  const headers: Record<string, string | string[]> = { ...plainHeaders };
  // See "Header bytes" above: a non-ASCII header value needs the body as bytes.
  if (typeof body === "string" && (hasNonAsciiValue(plainHeaders) || hasNonAsciiCookie(cookies))) {
    body = Buffer.from(body);
  }
  if (cookies.length > 0) {
    // A Set-Cookie put in the plain headers by `reply.header()` is a cookie
    // too; it goes out alongside the `reply.cookie()` ones, not instead.
    const fromHeader = headers["set-cookie"];
    headers["set-cookie"] = typeof fromHeader === "string" ? [fromHeader, ...cookies] : (cookies as string[]);
  }
  sendWhole(res, status, headers, body);
}

/** Write a Response that has no fast payload: its headers, then its body stream chunk by chunk. */
async function drainResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;

  // Framed as `frame` frames a fast response: a Transfer-Encoding frames the
  // body, so no Content-Length goes with it, and one whose last coding is not
  // chunked ends only when the connection does; a 204 carries neither.
  const noContent = response.status === 204;
  const codings = noContent ? null : response.headers.get("transfer-encoding");
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue; // handled below
    if ((codings !== null || noContent) && key === "content-length") continue;
    if (noContent && key === "transfer-encoding") continue;
    res.setHeader(key, value);
  }
  if (codings !== null && response.status !== 304 && res.req?.method !== "HEAD" && !CHUNKED_LAST.test(codings)) {
    res.setHeader("connection", "close");
  }

  // BUG-3 fix: preserve multiple Set-Cookie headers (entries() collapses them)
  const cookies = (response.headers as any).getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    res.setHeader("set-cookie", cookies);
  }

  if (response.body) {
    const reader = response.body.getReader();
    let disconnected = false;
    let failure: Error | undefined;
    let drain: (() => void) | undefined;
    const onClose = () => {
      disconnected = true;
      // destroy(error) can close a ServerResponse without an 'error' event.
      // Preserve that cause while ordinary client disconnects remain quiet.
      failure ??= res.errored ?? undefined;
      // Cancel resolves a pending read even for an idle stream (e.g. SSE).
      // Do not await user-supplied cancellation work, which may never settle.
      void reader.cancel(failure).catch(() => {});
      drain?.();
    };
    const onError = (error: Error) => {
      failure = error;
      onClose();
    };
    res.once("close", onClose);
    res.once("error", onError);
    try {
      while (!disconnected && !res.destroyed) {
        const { done, value } = await reader.read();
        if (done || disconnected || res.destroyed) break;
        if (!res.write(value)) {
          await new Promise<void>((resolve) => {
            drain = resolve;
            res.once("drain", resolve);
            if (disconnected || res.destroyed) resolve();
          });
          if (drain) res.off("drain", drain);
          drain = undefined;
        }
      }
      if (failure) throw failure;
    } catch (error) {
      void reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      res.off("close", onClose);
      res.off("error", onError);
      if (drain) res.off("drain", drain);
      reader.releaseLock();
    }
  }
  if (!res.destroyed) res.end();
}
