// @celsian/core — CelsianReply implementation

import type { CelsianReply } from './types.js';
import { serializeCookie, type CookieOptions } from './cookie.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export function createReply(): CelsianReply {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  let sent = false;

  const reply: CelsianReply = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(code: number) {
      statusCode = code;
    },

    get headers() {
      return headers;
    },

    get sent() {
      return sent;
    },
    set sent(value: boolean) {
      sent = value;
    },

    status(code: number) {
      statusCode = code;
      return reply;
    },

    header(key: string, value: string) {
      headers[key.toLowerCase()] = value;
      return reply;
    },

    send(data: unknown): Response {
      sent = true;
      if (data instanceof Response) {
        return data;
      }
      // No-body status codes (204, 304) — ignore data
      if (statusCode === 204 || statusCode === 304) {
        return new Response(null, {
          status: statusCode,
          headers: setCookies.length === 0 ? headers : buildHeaders(headers),
        });
      }
      if (data === null || data === undefined) {
        return new Response(null, {
          status: statusCode,
          headers: setCookies.length === 0 ? headers : buildHeaders(headers),
        });
      }
      if (typeof data === 'string') {
        const h = { 'content-type': 'text/plain; charset=utf-8', ...headers };
        return new Response(data, {
          status: statusCode,
          headers: setCookies.length === 0 ? h : buildHeaders(h),
        });
      }
      const h = { 'content-type': 'application/json; charset=utf-8', ...headers };
      return new Response(JSON.stringify(data), {
        status: statusCode,
        headers: setCookies.length === 0 ? h : buildHeaders(h),
      });
    },

    html(content: string): Response {
      sent = true;
      const h = { 'content-type': 'text/html; charset=utf-8', ...headers };
      return new Response(content, {
        status: statusCode,
        headers: setCookies.length === 0 ? h : buildHeaders(h),
      });
    },

    json(data: unknown): Response {
      sent = true;
      const body = JSON.stringify(data);
      // Fast path: no cookies set — use plain object headers (avoids new Headers())
      if (setCookies.length === 0) {
        return new Response(body, {
          status: statusCode,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            ...headers,
          },
        });
      }
      return new Response(body, {
        status: statusCode,
        headers: buildHeaders({
          'content-type': 'application/json; charset=utf-8',
          ...headers,
        }),
      });
    },

    stream(readable: ReadableStream): Response {
      sent = true;
      return new Response(readable, {
        status: statusCode,
        headers: buildHeaders({
          'content-type': 'application/octet-stream',
          ...headers,
        }),
      });
    },

    redirect(url: string, code = 302): Response {
      sent = true;
      return new Response(null, {
        status: code,
        headers: buildHeaders({ location: url, ...headers }),
      });
    },

    cookie(name: string, value: string, options?: CookieOptions) {
      setCookies.push(serializeCookie(name, value, options));
      return reply;
    },

    clearCookie(name: string, options?: CookieOptions) {
      setCookies.push(serializeCookie(name, '', { ...options, maxAge: 0 }));
      return reply;
    },

    async sendFile(filePath: string): Promise<Response> {
      sent = true;
      try {
        // Lazy import — keeps reply.ts edge-compatible when sendFile isn't used
        const { readFile, stat } = await import('node:fs/promises');
        const { extname } = await import('node:path');
        await stat(filePath);
        const data = await readFile(filePath);
        const ext = extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        return new Response(data, {
          status: statusCode,
          headers: buildHeaders({ 'content-type': contentType, ...headers }),
        });
      } catch {
        return new Response(
          JSON.stringify({ error: 'Not Found', statusCode: 404, code: 'NOT_FOUND' }),
          { status: 404, headers: buildHeaders({ 'content-type': 'application/json; charset=utf-8' }) },
        );
      }
    },

    async download(filePath: string, filename?: string): Promise<Response> {
      sent = true;
      try {
        // Lazy import — keeps reply.ts edge-compatible when download isn't used
        const { readFile, stat } = await import('node:fs/promises');
        const { extname, basename } = await import('node:path');
        await stat(filePath);
        const data = await readFile(filePath);
        const ext = extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        const downloadName = filename ?? basename(filePath);
        return new Response(data, {
          status: statusCode,
          headers: buildHeaders({
            'content-type': contentType,
            'content-disposition': `attachment; filename="${downloadName}"`,
            ...headers,
          }),
        });
      } catch {
        return new Response(
          JSON.stringify({ error: 'Not Found', statusCode: 404, code: 'NOT_FOUND' }),
          { status: 404, headers: buildHeaders({ 'content-type': 'application/json; charset=utf-8' }) },
        );
      }
    },

    // ─── Status Code Helpers ───

    notFound(message = 'Not Found') {
      return errorResponse(reply, 404, 'NOT_FOUND', message);
    },
    badRequest(message = 'Bad Request') {
      return errorResponse(reply, 400, 'BAD_REQUEST', message);
    },
    unauthorized(message = 'Unauthorized') {
      return errorResponse(reply, 401, 'UNAUTHORIZED', message);
    },
    forbidden(message = 'Forbidden') {
      return errorResponse(reply, 403, 'FORBIDDEN', message);
    },
    conflict(message = 'Conflict') {
      return errorResponse(reply, 409, 'CONFLICT', message);
    },
    gone(message = 'Gone') {
      return errorResponse(reply, 410, 'GONE', message);
    },
    tooManyRequests(message = 'Too Many Requests') {
      return errorResponse(reply, 429, 'TOO_MANY_REQUESTS', message);
    },
    internalServerError(message?: string) {
      return errorResponse(reply, 500, 'INTERNAL_SERVER_ERROR', message ?? 'Internal Server Error', true);
    },
    serviceUnavailable(message?: string) {
      return errorResponse(reply, 503, 'SERVICE_UNAVAILABLE', message ?? 'Service Unavailable', true);
    },
  };

  function errorResponse(
    r: CelsianReply,
    status: number,
    code: string,
    message: string,
    sanitizeInProd = false,
  ): Response {
    const safeMessage =
      sanitizeInProd && process.env.NODE_ENV === 'production'
        ? (status === 500 ? 'Internal Server Error' : 'Service Unavailable')
        : message;
    return r.status(status).json({ error: safeMessage, statusCode: status, code });
  }

  function buildHeaders(extra: Record<string, string> = {}): Headers {
    const h = new Headers(extra);
    for (const cookie of setCookies) {
      h.append('set-cookie', cookie);
    }
    return h;
  }

  return reply;
}
