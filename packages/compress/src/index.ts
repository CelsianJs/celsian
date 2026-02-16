// @celsian/compress — Response compression plugin

import type { PluginFunction, HookHandler, CelsianRequest, CelsianReply } from '@celsian/core';

export type CompressionEncoding = 'gzip' | 'deflate';

export interface CompressOptions {
  threshold?: number;
  encodings?: CompressionEncoding[];
}

const DEFAULT_THRESHOLD = 1024;
const DEFAULT_ENCODINGS: CompressionEncoding[] = ['gzip', 'deflate'];

function negotiateEncoding(
  acceptEncoding: string,
  supported: CompressionEncoding[],
): CompressionEncoding | null {
  const accepted = acceptEncoding.toLowerCase();
  for (const encoding of supported) {
    if (accepted.includes(encoding)) {
      return encoding;
    }
  }
  return null;
}

function compressBody(
  body: string,
  encoding: CompressionEncoding,
  contentType: string,
  statusCode: number,
  extraHeaders: Headers,
): Response {
  const cs = new CompressionStream(encoding);
  const writer = cs.writable.getWriter();
  const encoded = new TextEncoder().encode(body);
  writer.write(encoded);
  writer.close();

  extraHeaders.set('content-encoding', encoding);
  extraHeaders.set('content-type', contentType);
  extraHeaders.delete('content-length');
  extraHeaders.append('vary', 'accept-encoding');

  return new Response(cs.readable, {
    status: statusCode,
    headers: extraHeaders,
  });
}

export function compress(options: CompressOptions = {}): PluginFunction {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const encodings = options.encodings ?? DEFAULT_ENCODINGS;

  return function compressPlugin(app) {
    const hook: HookHandler = (request: CelsianRequest, reply: CelsianReply) => {
      const acceptEncoding = request.headers.get('accept-encoding') ?? '';
      const encoding = negotiateEncoding(acceptEncoding, encodings);

      if (!encoding) return;

      // Wrap reply methods to compress output above threshold
      const originalJson = reply.json.bind(reply);
      const originalSend = reply.send.bind(reply);
      const originalHtml = reply.html.bind(reply);

      reply.json = (data: unknown): Response => {
        const body = JSON.stringify(data);
        if (body.length < threshold) return originalJson(data);
        reply.sent = true;
        const headers = new Headers(reply.headers);
        return compressBody(body, encoding, 'application/json; charset=utf-8', reply.statusCode, headers);
      };

      reply.send = (data: unknown): Response => {
        if (data instanceof Response) return data;
        const body = typeof data === 'string' ? data : JSON.stringify(data);
        if (body.length < threshold) return originalSend(data);
        reply.sent = true;
        const ct = typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
        const headers = new Headers(reply.headers);
        return compressBody(body, encoding, ct, reply.statusCode, headers);
      };

      reply.html = (content: string): Response => {
        if (content.length < threshold) return originalHtml(content);
        reply.sent = true;
        const headers = new Headers(reply.headers);
        return compressBody(content, encoding, 'text/html; charset=utf-8', reply.statusCode, headers);
      };
    };

    app.addHook('onRequest', hook as HookHandler);
  };
}
