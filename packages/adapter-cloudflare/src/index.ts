// @celsian/adapter-cloudflare — Cloudflare Workers adapter

import type { CelsianApp } from "@celsian/core";

/**
 * Cloudflare Workers environment bindings (KV, D1, R2, etc.)
 * Users extend this interface for their specific bindings.
 */
export interface CloudflareEnv {
  [key: string]: unknown;
}

/**
 * Cloudflare Workers execution context.
 * Provides waitUntil() for background work after response.
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * Cloudflare Workers module export format.
 */
export interface CloudflareWorkerExport {
  fetch: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>;
}

/**
 * Create a Cloudflare Workers handler.
 * Cloudflare Workers already uses Web Standard APIs (Request/Response),
 * so this adapter mainly passes through env bindings and execution context.
 */
export function createCloudflareHandler(app: CelsianApp): CloudflareWorkerExport {
  return {
    async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
      try {
        // Attach Cloudflare env and ctx to request for handler access
        (request as unknown as Record<string, unknown>).env = env;
        (request as unknown as Record<string, unknown>).ctx = ctx;
        return await app.handle(request);
      } catch (error) {
        console.error("[celsian] Unhandled error in Cloudflare handler:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error", statusCode: 500 }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    },
  };
}
