// @celsian/adapter-deno — Deno.serve adapter for CelsianJS
//
// Deno.serve uses Web Standard Request/Response natively, so this adapter is thin:
// it wraps app.handle(request) and returns a Deno.serve-compatible handler.

import type { CelsianApp } from "@celsian/core";

/** Options for the Deno adapter. */
export interface DenoAdapterOptions {
  /** Port to listen on (default: 3000 or PORT env var) */
  port?: number;
  /** Hostname to bind to (default: '0.0.0.0') */
  hostname?: string;
  /** AbortSignal to gracefully shut down the server */
  signal?: AbortSignal;
  /** Callback when the server starts listening */
  onListen?: (info: { port: number; hostname: string }) => void;
}

/**
 * Deno.serve handler shape — accepts a Request and returns a Response.
 */
export type DenoFetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * Deno.serve options shape (subset of Deno's types, avoids depending on deno-types).
 */
export interface DenoServeOptions {
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { port: number; hostname: string }) => void;
}

/**
 * Create a Deno.serve-compatible handler from a CelsianJS app.
 *
 * @example
 * ```ts
 * import { createApp } from "@celsian/core";
 * import { createDenoHandler } from "@celsian/adapter-deno";
 *
 * const app = createApp();
 * app.get("/hello", () => ({ message: "world" }));
 * await app.ready();
 *
 * Deno.serve({ port: 3000 }, createDenoHandler(app));
 * ```
 */
export function createDenoHandler(app: CelsianApp): DenoFetchHandler {
  return async (request: Request): Promise<Response> => {
    try {
      return await app.handle(request);
    } catch (error) {
      console.error("[celsian] Unhandled error in Deno handler:", error);
      return new Response(
        JSON.stringify({ error: "Internal Server Error", statusCode: 500 }),
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
  };
}

/**
 * Start a Deno.serve server with a CelsianJS app.
 * Convenience wrapper that calls Deno.serve() directly.
 *
 * @example
 * ```ts
 * import { createApp } from "@celsian/core";
 * import { serveDeno } from "@celsian/adapter-deno";
 *
 * const app = createApp();
 * app.get("/hello", () => ({ message: "world" }));
 * await app.ready();
 *
 * serveDeno(app, { port: 3000 });
 * ```
 */
export function serveDeno(app: CelsianApp, options: DenoAdapterOptions = {}): void {
  const port = options.port ?? parseInt(
    (typeof process !== "undefined" ? process.env.PORT : undefined) ?? "3000",
    10,
  );
  const hostname = options.hostname ?? "0.0.0.0";

  const handler = createDenoHandler(app);

  // Call Deno.serve — we use globalThis to avoid needing Deno types at compile time
  const Deno = (globalThis as Record<string, unknown>).Deno as {
    serve: (opts: DenoServeOptions, handler: DenoFetchHandler) => void;
  } | undefined;

  if (!Deno?.serve) {
    throw new Error("Deno.serve is not available. This adapter requires the Deno runtime.");
  }

  Deno.serve(
    {
      port,
      hostname,
      signal: options.signal,
      onListen: options.onListen ?? ((info) => {
        console.log(`[celsian] Server running at http://${info.hostname}:${info.port}`);
      }),
    },
    handler,
  );
}

export default createDenoHandler;
