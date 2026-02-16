// @celsian/core — CelsianReply implementation

import type { CelsianReply } from './types.js';
import { serializeCookie, type CookieOptions } from './cookie.js';

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
      if (typeof data === 'string') {
        return new Response(data, {
          status: statusCode,
          headers: buildHeaders({
            'content-type': 'text/plain; charset=utf-8',
            ...headers,
          }),
        });
      }
      return new Response(JSON.stringify(data), {
        status: statusCode,
        headers: buildHeaders({
          'content-type': 'application/json; charset=utf-8',
          ...headers,
        }),
      });
    },

    html(content: string): Response {
      sent = true;
      return new Response(content, {
        status: statusCode,
        headers: buildHeaders({
          'content-type': 'text/html; charset=utf-8',
          ...headers,
        }),
      });
    },

    json(data: unknown): Response {
      sent = true;
      return new Response(JSON.stringify(data), {
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
  };

  function buildHeaders(extra: Record<string, string> = {}): Headers {
    const h = new Headers(extra);
    for (const cookie of setCookies) {
      h.append('set-cookie', cookie);
    }
    return h;
  }

  return reply;
}
