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
    const secret = cronSecret ?? process.env.CRON_SECRET;
    if (!secret) {
      console.error("[celsian] CRON_SECRET not set — cron endpoint is unprotected");
      // Fall through without validation if no secret configured (dev mode)
    } else {
      const authHeader = request.headers.get("authorization");
      if (authHeader !== `Bearer ${secret}`) {
        return new Response(JSON.stringify({ error: "Unauthorized", statusCode: 401 }), {
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
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
