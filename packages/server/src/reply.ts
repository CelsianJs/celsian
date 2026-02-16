// @celsian/server — CelsianReply implementation

import type { CelsianReply } from './types.js';

export function createReply(): CelsianReply {
  let statusCode = 200;
  const headers: Record<string, string> = {};
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
      // Null body statuses (204, 304) must not have a body
      if (data === null || data === undefined) {
        return new Response(null, {
          status: statusCode,
          headers,
        });
      }
      if (typeof data === 'string') {
        return new Response(data, {
          status: statusCode,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            ...headers,
          },
        });
      }
      return new Response(JSON.stringify(data), {
        status: statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...headers,
        },
      });
    },

    html(content: string): Response {
      sent = true;
      return new Response(content, {
        status: statusCode,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          ...headers,
        },
      });
    },

    json(data: unknown): Response {
      sent = true;
      return new Response(JSON.stringify(data), {
        status: statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...headers,
        },
      });
    },

    stream(readable: ReadableStream): Response {
      sent = true;
      return new Response(readable, {
        status: statusCode,
        headers: {
          'content-type': 'application/octet-stream',
          ...headers,
        },
      });
    },

    redirect(url: string, code = 302): Response {
      sent = true;
      return new Response(null, {
        status: code,
        headers: {
          location: url,
          ...headers,
        },
      });
    },
  };

  return reply;
}
