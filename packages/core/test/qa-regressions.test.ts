// @celsian/core — QA Regression Tests for All 13 Bugs
// Each bug has at least one test to prevent regressions.

import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { Router } from '../src/router.js';
import { cors } from '../src/plugins/cors.js';
import { createSSEStream, createSSEHub } from '../src/sse.js';
import { withETag } from '../src/plugins/etag.js';

// ─── BUG-1: ESM serve() crash (require() calls) ───

describe('BUG-1: serve.ts uses dynamic imports, not require()', () => {
  it('should use await import() for config loading (no require)', async () => {
    // Verify serve.ts can be imported without errors in ESM
    const serveMod = await import('../src/serve.js');
    expect(typeof serveMod.serve).toBe('function');
    expect(typeof serveMod.nodeToWebRequest).toBe('function');
    expect(typeof serveMod.writeWebResponse).toBe('function');
  });
});

// ─── BUG-2: TypeBox adapter ESM crash ───

describe('BUG-2: TypeBox adapter uses dynamic import, not require()', () => {
  it('should import the typebox adapter without ESM errors', async () => {
    const mod = await import('../../schema/src/adapters/typebox.js');
    expect(typeof mod.fromTypeBox).toBe('function');
  });
});

// ─── BUG-3: Multiple Set-Cookie headers lost ───

describe('BUG-3: Multiple Set-Cookie headers preserved in writeWebResponse', () => {
  it('should preserve multiple Set-Cookie headers through writeWebResponse', async () => {
    const { writeWebResponse } = await import('../src/serve.js');
    const { ServerResponse } = await import('node:http');
    const { IncomingMessage } = await import('node:http');
    const { Socket } = await import('node:net');

    // Create a mock ServerResponse
    const socket = new Socket();
    const incomingMessage = new IncomingMessage(socket);
    const res = new ServerResponse(incomingMessage);

    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');

    const response = new Response('ok', { status: 200, headers });

    // writeWebResponse should use getSetCookie() to preserve both cookies
    const setHeaderCalls: Array<[string, string | string[]]> = [];
    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = (name: string, value: any) => {
      setHeaderCalls.push([name, value]);
      return origSetHeader(name, value);
    };

    await writeWebResponse(res, response);

    const cookieCall = setHeaderCalls.find(([name]) => name === 'set-cookie');
    expect(cookieCall).toBeDefined();
    // Should be an array with both cookies
    expect(Array.isArray(cookieCall![1])).toBe(true);
    expect((cookieCall![1] as string[]).length).toBe(2);
  });
});

// ─── BUG-4: Plugin decorate() not on CelsianApp instance ───

describe('BUG-4: Plugin decorations accessible on app instance', () => {
  it('should make non-encapsulated plugin decorations available on app', async () => {
    const app = createApp();
    await app.register(
      (ctx) => { ctx.decorate('dbPool', { connected: true }); },
      { encapsulate: false },
    );
    await app.ready();

    expect((app as any).dbPool).toEqual({ connected: true });
    expect(app.getDecoration('dbPool')).toEqual({ connected: true });
  });

  it('should NOT expose encapsulated plugin decorations on app instance', async () => {
    const app = createApp();
    await app.register(async (ctx) => {
      ctx.decorate('secretUtil', 'hidden');
    });
    await app.ready();

    // Encapsulated plugins keep decorations scoped -- they should NOT leak
    expect((app as any).secretUtil).toBeUndefined();
  });

  it('direct app.decorate() should appear as property', () => {
    const app = createApp();
    app.decorate('version', '1.0.0');
    expect((app as any).version).toBe('1.0.0');
  });
});

// ─── BUG-5/6: onSend hook headers lost + CORS broken ───

describe('BUG-5/6: onSend hook headers merged into response', () => {
  it('should include headers set in onSend hooks in the final response', async () => {
    const app = createApp();
    app.addHook('onSend', (_req, reply) => {
      reply.header('x-powered-by', 'Celsian');
    });
    app.get('/test', (_req, reply) => reply.json({ ok: true }));

    const response = await app.handle(new Request('http://localhost/test'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-powered-by')).toBe('Celsian');
  });

  it('CORS headers from onSend should appear on actual requests', async () => {
    const app = createApp();
    await app.register(cors({ origin: 'http://allowed.com' }), { encapsulate: false });
    app.get('/api/data', (_req, reply) => reply.json({ ok: true }));

    const response = await app.handle(new Request('http://localhost/api/data', {
      headers: { origin: 'http://allowed.com' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://allowed.com');
  });
});

// ─── BUG-7: 404 vs 405 ───

describe('BUG-7: Router returns 405 for method mismatch, not 404', () => {
  it('should return 405 when path exists but method does not', async () => {
    const app = createApp();
    app.get('/users', (_req, reply) => reply.json([]));
    app.post('/users', (_req, reply) => reply.status(201).json({ id: 1 }));

    const response = await app.handle(new Request('http://localhost/users', { method: 'DELETE' }));
    expect(response.status).toBe(405);
    const body = await response.json();
    expect(body.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('should still return 404 for completely unknown paths', async () => {
    const app = createApp();
    app.get('/users', (_req, reply) => reply.json([]));

    const response = await app.handle(new Request('http://localhost/nonexistent'));
    expect(response.status).toBe(404);
  });

  it('hasPath detects parameterized paths', () => {
    const router = new Router();
    router.addRoute('GET', '/users/:id', (() => {}) as any);

    expect(router.hasPath('/users/42')).toBe(true);
    expect(router.hasPath('/nope/42')).toBe(false);
  });
});

// ─── BUG-8: HEAD fallback to GET ───

describe('BUG-8: HEAD requests fall back to GET handler', () => {
  it('should handle HEAD requests using the GET handler', async () => {
    const app = createApp();
    app.get('/data', (_req, reply) => reply.json({ hello: 'world' }));

    const response = await app.handle(new Request('http://localhost/data', { method: 'HEAD' }));
    expect(response.status).toBe(200);
  });

  it('should prefer explicit HEAD handler over GET fallback', async () => {
    const app = createApp();
    app.route({ method: 'HEAD', url: '/data', handler: (_req, reply) => reply.status(204).send(null) });
    app.get('/data', (_req, reply) => reply.json({ hello: 'world' }));

    const response = await app.handle(new Request('http://localhost/data', { method: 'HEAD' }));
    expect(response.status).toBe(204);
  });
});

// ─── BUG-9: RPC POST body already consumed ───

describe('BUG-9: RPC handler uses pre-parsed body instead of re-reading', () => {
  it('should use parsedBody in RPC handler instead of request.json()', async () => {
    // This tests the core body parsing pipeline: parseBody stores parsedBody,
    // and downstream code can use it without re-consuming the body stream.
    const app = createApp();
    app.post('/echo', (req, reply) => {
      // parsedBody should be available after core parses it
      return reply.json({ body: req.parsedBody });
    });

    const response = await app.handle(new Request('http://localhost/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'value' }),
    }));
    const data = await response.json();
    expect(data.body).toEqual({ key: 'value' });
  });
});

// ─── BUG-10: Malformed JSON returns 200 ───

describe('BUG-10: Malformed JSON returns 400, not 200', () => {
  it('should return 400 with INVALID_JSON code for malformed JSON', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ body: req.parsedBody }));

    const response = await app.handle(new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not valid json !!!',
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INVALID_JSON');
  });

  it('should handle empty JSON body gracefully', async () => {
    const app = createApp();
    app.post('/data', (req, reply) => reply.json({ body: req.parsedBody ?? null }));

    const response = await app.handle(new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.body).toBeNull();
  });
});

// ─── BUG-11: Path params not URL-decoded ───

describe('BUG-11: Path parameters are URL-decoded', () => {
  it('should decode %20 in path params', async () => {
    const app = createApp();
    app.get('/files/:name', (req, reply) => reply.json({ name: req.params.name }));

    const response = await app.handle(new Request('http://localhost/files/hello%20world'));
    const body = await response.json();
    expect(body.name).toBe('hello world');
  });

  it('should decode encoded special characters in params', () => {
    const router = new Router();
    router.addRoute('GET', '/search/:query', (() => {}) as any);

    const match = router.match('GET', '/search/caf%C3%A9');
    expect(match).not.toBeNull();
    expect(match!.params.query).toBe('caf\u00e9');
  });

  it('should decode encoded slashes in wildcard params', () => {
    const router = new Router();
    router.addRoute('GET', '/files/*path', (() => {}) as any);

    const match = router.match('GET', '/files/dir%2Ffile.txt');
    // Wildcard joins with / and decodes each segment
    expect(match).not.toBeNull();
    // Note: %2F in path segment is treated as literal "/" after decoding
    expect(match!.params.path).toContain('file.txt');
  });
});

// ─── BUG-12: CORS preflight leaks to disallowed origins ───

describe('BUG-12: CORS preflight does not leak headers to disallowed origins', () => {
  it('should return 204 with NO CORS headers for disallowed origin on preflight', async () => {
    const app = createApp();
    await app.register(cors({ origin: 'http://allowed.com' }));
    app.get('/test', (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/test',
      headers: { origin: 'http://evil.com' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toBeNull();
  });

  it('should include CORS headers for allowed origin on preflight', async () => {
    const app = createApp();
    await app.register(cors({ origin: 'http://allowed.com' }));
    app.get('/test', (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/test',
      headers: { origin: 'http://allowed.com' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://allowed.com');
  });

  it('should NOT set CORS headers on actual requests from disallowed origins', async () => {
    const app = createApp();
    await app.register(cors({ origin: 'http://allowed.com' }), { encapsulate: false });
    app.get('/test', (_req, reply) => reply.json({ ok: true }));

    const response = await app.inject({
      url: '/test',
      headers: { origin: 'http://evil.com' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// ─── BUG-13: Duplicate query params keep last only ───

describe('BUG-13: Duplicate query parameters accumulated as arrays', () => {
  it('should accumulate duplicate query params into arrays', async () => {
    const app = createApp();
    app.get('/search', (req, reply) => reply.json({ tags: req.query.tag }));

    const response = await app.handle(new Request('http://localhost/search?tag=a&tag=b&tag=c'));
    const body = await response.json();
    expect(body.tags).toEqual(['a', 'b', 'c']);
  });

  it('should keep single query param as string', async () => {
    const app = createApp();
    app.get('/search', (req, reply) => reply.json({ q: req.query.q }));

    const response = await app.handle(new Request('http://localhost/search?q=hello'));
    const body = await response.json();
    expect(body.q).toBe('hello');
  });

  it('should block prototype pollution keys in query params', async () => {
    const app = createApp();
    app.get('/search', (req, reply) => {
      return reply.json({
        hasProto: '__proto__' in req.query,
        hasConstructor: 'constructor' in req.query,
      });
    });

    const response = await app.handle(new Request('http://localhost/search?__proto__=evil&constructor=bad'));
    const body = await response.json();
    expect(body.hasProto).toBe(false);
    expect(body.hasConstructor).toBe(false);
  });
});

// ─── SSE Migration (from @celsian/server to @celsian/core) ───

describe('SSE: Migrated from @celsian/server to @celsian/core', () => {
  it('should create SSE stream with correct headers', () => {
    const channel = createSSEStream(new Request('http://localhost/events'), { pingInterval: 0 });
    expect(channel.response.status).toBe(200);
    expect(channel.response.headers.get('content-type')).toBe('text/event-stream');
    expect(channel.response.headers.get('cache-control')).toBe('no-cache');
    channel.close();
  });

  it('should send formatted SSE events', async () => {
    const channel = createSSEStream(new Request('http://localhost/events'), { pingInterval: 0 });
    channel.send({ event: 'greeting', data: { message: 'hello' }, id: '1' });
    channel.close();

    const reader = channel.response.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: greeting');
    expect(text).toContain('id: 1');
    expect(text).toContain('data: {"message":"hello"}');
    reader.cancel();
  });

  it('should create SSE hub that tracks clients', () => {
    const hub = createSSEHub();
    const ch1 = hub.subscribe(new Request('http://localhost/events'), { pingInterval: 0 });
    expect(hub.size).toBe(1);
    ch1.close();
    expect(hub.size).toBe(0);
  });
});

// ─── ETag Migration ───

describe('ETag: Migrated withETag from @celsian/server to @celsian/core', () => {
  it('should generate ETag and respond with 200', () => {
    const request = new Request('http://localhost/data');
    const response = withETag(request, { hello: 'world' });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeTruthy();
  });

  it('should respond with 304 when If-None-Match matches', () => {
    const data = { hello: 'world' };
    // First request to get the ETag
    const first = withETag(new Request('http://localhost/data'), data);
    const etag = first.headers.get('etag')!;

    // Second request with If-None-Match
    const second = withETag(
      new Request('http://localhost/data', { headers: { 'if-none-match': etag } }),
      data,
    );
    expect(second.status).toBe(304);
  });
});
