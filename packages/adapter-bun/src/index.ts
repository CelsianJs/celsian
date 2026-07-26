// @celsian/adapter-bun, Bun.serve adapter for CelsianJS
//
// Bun.serve uses Web Standard Request/Response natively, so the HTTP side is thin:
// it wraps app.handle(request). WebSocket upgrades are bridged to the app's WS
// registry through Bun's `websocket` handler contract.

import {
  authorizeWSUpgrade,
  buildRequest,
  type CelsianApp,
  createWSConnection,
  type WSAllowedOrigins,
  type WSConnection,
  WSConnectionLimiter,
} from "@celsian/core";

/** Options for the Bun adapter. */
export interface BunAdapterOptions {
  /** Port to listen on (default: 3000 or PORT env var) */
  port?: number;
  /** Hostname to bind to (default: '0.0.0.0') */
  hostname?: string;
  /**
   * Origins permitted to open a WebSocket. Accepts an origin, a list, `"*"`, or a
   * predicate. Default: same-origin only (the handshake's `Origin` must match `Host`).
   * WebSocket handshakes are exempt from CORS, so this is the CSWSH defence.
   */
  allowedOrigins?: WSAllowedOrigins;
  /** Permit WebSocket handshakes with no `Origin` header (non-browser clients). Default: `false`. */
  allowMissingOrigin?: boolean;
  /** Skip the app's root `onRequest` hooks on WebSocket handshakes. Default: `false` (hooks run). */
  skipUpgradeHooks?: boolean;
  /** Max WebSocket message size in bytes (default: 1 MiB). */
  maxPayload?: number;
  /** Max concurrent WebSocket connections per client IP (default: 64; 0 disables). */
  maxConnectionsPerIP?: number;
}

/**
 * Bun.serve fetch handler. Returns `undefined` after a successful
 * `server.upgrade()`, Bun requires that, not a synthetic 101 response.
 */
export type BunFetchHandler = (
  request: Request,
  server: BunServer,
) => Response | undefined | Promise<Response | undefined>;

/** The subset of Bun's `Server` this adapter uses (avoids depending on bun-types). */
export interface BunServer {
  upgrade(request: Request, options?: { data?: unknown; headers?: Headers | Record<string, string> }): boolean;
  requestIP?: (request: Request) => { address: string } | null;
}

/** Per-socket data Bun hands back to the websocket callbacks via `ws.data`. */
export interface BunWSData {
  pathname: string;
  ip: string;
  request: Request;
}

/** The subset of Bun's `ServerWebSocket` this adapter uses. */
export interface BunWebSocket {
  data: BunWSData;
  send(data: string | ArrayBuffer): number | void;
  close(code?: number, reason?: string): void;
}

/** Bun's `websocket` handler contract. */
export interface BunWebSocketHandler {
  open(ws: BunWebSocket): void;
  message(ws: BunWebSocket, message: string | ArrayBuffer | Uint8Array): void;
  close(ws: BunWebSocket, code: number, reason: string): void;
  drain(ws: BunWebSocket): void;
  maxPayloadLength?: number;
}

/** Full Bun.serve options shape (subset of Bun's types). */
export interface BunServeOptions {
  port?: number;
  hostname?: string;
  fetch: BunFetchHandler;
  websocket?: BunWebSocketHandler;
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Create the Bun `websocket` handler that bridges Bun's ServerWebSocket to the
 * app's WS registry. Must be passed to `Bun.serve({ websocket })`, without it
 * `server.upgrade()` cannot succeed.
 */
export function createBunWebSocketHandler(app: CelsianApp, options: BunAdapterOptions = {}): BunWebSocketHandler {
  const limiter = new WSConnectionLimiter(options.maxConnectionsPerIP ?? 64);
  // Bun gives us its own ServerWebSocket; map it to the CelsianJS connection.
  const connections = new WeakMap<BunWebSocket, WSConnection>();

  return {
    maxPayloadLength: options.maxPayload ?? 1024 * 1024,

    open(ws) {
      const { pathname, ip, request } = ws.data;
      const handler = app.wsRegistry.getHandler(pathname);
      if (!handler) {
        ws.close(1011, "No handler");
        return;
      }
      if (!limiter.acquire(ip)) {
        ws.close(1013, "Too many connections");
        return;
      }

      const conn = createWSConnection({
        send: (data) => {
          ws.send(data);
        },
        close: (code, reason) => ws.close(code, reason),
      });
      connections.set(ws, conn);
      app.wsRegistry.addConnection(pathname, conn);

      handler.open?.(conn, buildRequest(request, new URL(request.url), {}));
    },

    message(ws, message) {
      const conn = connections.get(ws);
      if (!conn) return;
      const handler = app.wsRegistry.getHandler(ws.data.pathname);
      if (!handler?.message) return;
      // Bun delivers binary frames as Uint8Array; the WSHandler contract is
      // string | ArrayBuffer.
      const data =
        typeof message === "string"
          ? message
          : message instanceof Uint8Array
            ? (message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer)
            : message;
      handler.message(conn, data);
    },

    close(ws, code, reason) {
      const conn = connections.get(ws);
      const { pathname, ip } = ws.data;
      limiter.release(ip);
      if (!conn) return;
      connections.delete(ws);
      app.wsRegistry.getHandler(pathname)?.close?.(conn, code, reason);
      app.wsRegistry.removeConnection(pathname, conn);
    },

    drain() {
      // Backpressure relieved. CelsianJS has no send-queue to flush, so nothing to do.
    },
  };
}

/**
 * Create a Bun.serve-compatible fetch handler from a CelsianJS app.
 *
 * WebSocket handshakes are gated by an Origin allow-list (same-origin by default)
 * and the app's root `onRequest` hooks before `server.upgrade()` is called.
 *
 * @example
 * ```ts
 * import { createApp } from "@celsian/core";
 * import { createBunHandler, createBunWebSocketHandler } from "@celsian/adapter-bun";
 *
 * const app = createApp();
 * app.get("/hello", () => ({ message: "world" }));
 * await app.ready();
 *
 * Bun.serve({
 *   port: 3000,
 *   fetch: createBunHandler(app),
 *   websocket: createBunWebSocketHandler(app),
 * });
 * ```
 */
export function createBunHandler(app: CelsianApp, options: BunAdapterOptions = {}): BunFetchHandler {
  return async (request: Request, server: BunServer): Promise<Response | undefined> => {
    if (app.wsRegistry.hasAnyHandlers() && isWebSocketUpgrade(request)) {
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (app.wsRegistry.getHandler(pathname)) {
        const decision = await authorizeWSUpgrade(app, request, pathname, {
          allowedOrigins: options.allowedOrigins,
          allowMissingOrigin: options.allowMissingOrigin,
          runRequestHooks: options.skipUpgradeHooks !== true,
        });
        if (!decision.allowed) {
          return new Response(decision.reason, { status: decision.status });
        }

        const ip = server.requestIP?.(request)?.address ?? "unknown";
        const data: BunWSData = { pathname, ip, request };
        // Bun completes the handshake itself; the fetch handler must return
        // undefined so Bun does not also write a response to the socket.
        if (server.upgrade(request, { data })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
    }

    try {
      return await app.handle(request);
    } catch (error) {
      console.error("[celsian] Unhandled error in Bun handler:", error);
      return new Response(JSON.stringify({ error: "Internal Server Error", statusCode: 500 }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  };
}

/**
 * Create full Bun.serve options from a CelsianJS app, including the `websocket`
 * handler when the app has `.ws()` routes.
 *
 * @example
 * ```ts
 * import { createApp } from "@celsian/core";
 * import { createBunServeOptions } from "@celsian/adapter-bun";
 *
 * const app = createApp();
 * app.get("/hello", () => ({ message: "world" }));
 * await app.ready();
 *
 * Bun.serve(createBunServeOptions(app, { port: 3000 }));
 * ```
 */
export function createBunServeOptions(app: CelsianApp, options: BunAdapterOptions = {}): BunServeOptions {
  const port = options.port ?? parseInt(process.env.PORT || "3000", 10);
  const hostname = options.hostname ?? "0.0.0.0";

  const serveOptions: BunServeOptions = {
    port,
    hostname,
    fetch: createBunHandler(app, options),
  };

  // Bun's `server.upgrade()` throws unless a `websocket` handler is configured.
  if (app.wsRegistry.hasAnyHandlers()) {
    serveOptions.websocket = createBunWebSocketHandler(app, options);
  }

  return serveOptions;
}

export default createBunHandler;
