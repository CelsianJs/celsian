// @celsian/adapter-vercel — Vercel deployment adapter

import type { CelsianApp } from '@celsian/core';
import { nodeToWebRequest, writeWebResponse } from '@celsian/core';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Create a Vercel Serverless Function handler (Node.js runtime).
 * Converts Node.js IncomingMessage to Web Request, processes via app.handle(),
 * and writes the Web Response back to ServerResponse.
 */
export function createVercelHandler(app: CelsianApp) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const proto = req.headers['x-forwarded-proto'] ?? 'https';
      const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
      const url = new URL(req.url ?? '/', `${proto}://${host}`);

      const webRequest = nodeToWebRequest(req, url);
      const response = await app.handle(webRequest);
      await writeWebResponse(res, response);
    } catch (error) {
      console.error('[celsian] Unhandled error in Vercel handler:', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Internal Server Error', statusCode: 500 }));
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
      console.error('[celsian] Unhandled error in Vercel Edge handler:', error);
      return new Response(
        JSON.stringify({ error: 'Internal Server Error', statusCode: 500 }),
        { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }
  };
}
