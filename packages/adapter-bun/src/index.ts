// @celsian/adapter-bun — Bun.serve adapter for CelsianJS
//
// Bun.serve uses Web Standard Request/Response natively, so this adapter is thin:
// it wraps app.handle(request) and optionally handles WebSocket upgrades.

import type { CelsianApp } from "@celsian/core";

/** Options for the Bun adapter. */
export interface BunAdapterOptions {
  /** Port to listen on (default: 3000 or PORT env var) */
  port?: number;
  /** Hostname to bind to (default: '0.0.0.0') */
  hostname?: string;
}

/**
 * Bun.serve handler shape — the `fetch` function that Bun.serve expects.
 * Accepts a Web Standard Request and returns a Response or Promise<Response>.
 */
export type BunFetchHandler = (request: Request, server: unknown) => Response | Promise<Response>;

/**
 * Full Bun.serve options shape (subset of Bun's types, avoids depending on bun-types).
 */
export interface BunServeOptions {
  port?: number;
  hostname?: string;
  fetch: BunFetchHandler;
  websocket?: {
    open?: (ws: unknown) => void;
    message?: (ws: unknown, message: string | ArrayBuffer) => void;
    close?: (ws: unknown, code: number, reason: string) => void;
  };
}

/**
 * Create a Bun.serve-compatible fetch handler from a CelsianJS app.
 *
 * @example
 * ```ts
 * import { createApp } from "@celsian/core";
 * import { createBunHandler } from "@celsian/adapter-bun";
 *
 * const app = createApp();
 * app.get("/hello", () => ({ message: "world" }));
 * await app.ready();
 *
 * Bun.serve({
 *   port: 3000,
 *   fetch: createBunHandler(app),
 * });
 * ```
 */
export function createBunHandler(app: CelsianApp): BunFetchHandler {
  return async (request: Request, server: unknown): Promise<Response> => {
    // Handle WebSocket upgrades if the app has WS routes
    if (app.wsRegistry.hasAnyHandlers()) {
      const url = new URL(request.url);
      const handler = app.wsRegistry.getHandler(url.pathname);
      if (handler && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        // Bun's server.upgrade() handles the WebSocket upgrade natively
        const upgraded = (server as { upgrade: (req: Request, opts?: unknown) => boolean })
          .upgrade(request, { data: { pathname: url.pathname } });
        if (upgraded) {
          // Bun returns undefined after upgrade; return a 101 placeholder
          return new Response(null, { status: 101 });
        }
      }
    }

    try {
      return await app.handle(request);
    } catch (error) {
      console.error("[celsian] Unhandled error in Bun handler:", error);
      return new Response(
        JSON.stringify({ error: "Internal Server Error", statusCode: 500 }),
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
  };
}

/**
 * Create full Bun.serve options from a CelsianJS app.
 * Includes WebSocket handling if the app has WS routes.
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
    fetch: createBunHandler(app),
  };

  return serveOptions;
}

export default createBunHandler;
