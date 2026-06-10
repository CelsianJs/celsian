// @celsian/adapter-vercel — Vercel deployment adapter

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CelsianApp } from "@celsian/core";
import { nodeToWebRequest, writeWebResponse } from "@celsian/core";

/**
 * Create a Vercel Serverless Function handler (Node.js runtime).
 * Converts Node.js IncomingMessage to Web Request, processes via app.handle(),
 * and writes the Web Response back to ServerResponse.
 */
export function createVercelHandler(app: CelsianApp) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const proto = req.headers["x-forwarded-proto"] ?? "https";
      const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
      const url = new URL(req.url ?? "/", `${proto}://${host}`);

      const webRequest = nodeToWebRequest(req, url);
      const response = await app.handle(webRequest);
      await writeWebResponse(res, response);
    } catch (error) {
      console.error("[celsian] Unhandled error in Vercel handler:", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Internal Server Error", statusCode: 500 }));
      }
    }
  };
}

/**
 * Create a Vercel Edge Function handler.
 * Vercel Edge uses Web Standard Request/Response, so this is a direct passthrough.
 */
export function createVercelEdgeHandler(app: CelsianApp) {
  return async (request: Request): Promise<Response> => {
    try {
      return await app.handle(request);
    } catch (error) {
      console.error("[celsian] Unhandled error in Vercel Edge handler:", error);
      return new Response(JSON.stringify({ error: "Internal Server Error", statusCode: 500 }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  };
}

/**
 * Timing-safe string comparison using Web Crypto (works on Node, Edge, Workers).
 * Hashes both inputs to fixed-length digests, then compares in constant time.
 * No `node:crypto` import — keeps the module bundleable for edge runtimes.
 */
async function timingSafeEqualWeb(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    globalThis.crypto.subtle.digest("SHA-256", encoder.encode(a)),
    globalThis.crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= (bytesA[i] as number) ^ (bytesB[i] as number);
  }
  return diff === 0;
}

/**
 * Create a Vercel Cron Job handler with CRON_SECRET validation.
 * Vercel Cron Jobs call API routes on a schedule. This handler validates
 * the Authorization header against the CRON_SECRET environment variable
 * to ensure only Vercel's scheduler can trigger the endpoint.
 *
 * @param app - CelsianApp instance
 * @param cronSecret - Optional secret override (defaults to process.env.CRON_SECRET)
 */
export function createVercelCronHandler(app: CelsianApp, cronSecret?: string) {
  return async (request: Request): Promise<Response> => {
    const secret = (cronSecret ?? process.env.CRON_SECRET ?? "").trim();
    if (!secret) {
      console.error("[celsian] CRON_SECRET not set — rejecting all cron requests");
      return new Response(JSON.stringify({ error: "Service Unavailable", statusCode: 503 }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const authHeader = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${secret}`;
    // Timing-safe comparison: hash both to normalize length, then compare digests
    if (!(await timingSafeEqualWeb(authHeader, expected))) {
      return new Response(JSON.stringify({ error: "Unauthorized", statusCode: 401 }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    try {
      return await app.handle(request);
    } catch (error) {
      console.error("[celsian] Unhandled error in Vercel Cron handler:", error);
      return new Response(JSON.stringify({ error: "Internal Server Error", statusCode: 500 }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  };
}
