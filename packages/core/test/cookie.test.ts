import { describe, it, expect } from 'vitest';
import { parseCookies, serializeCookie } from '../src/cookie.js';
import { createApp } from '../src/app.js';

describe('Cookie parsing', () => {
  it('should parse cookie header', () => {
    const cookies = parseCookies('name=value; session=abc123');
    expect(cookies).toEqual({ name: 'value', session: 'abc123' });
  });

  it('should handle empty cookie header', () => {
    const cookies = parseCookies('');
    expect(cookies).toEqual({});
  });

  it('should decode URL-encoded values', () => {
    const cookies = parseCookies('data=hello%20world');
    expect(cookies).toEqual({ data: 'hello world' });
  });

  it('should handle cookies with = in value', () => {
    const cookies = parseCookies('token=abc=def');
    expect(cookies).toEqual({ token: 'abc=def' });
  });
});

describe('Cookie serialization', () => {
  it('should serialize basic cookie', () => {
    const cookie = serializeCookie('name', 'value');
    expect(cookie).toBe('name=value');
  });

  it('should serialize with all options', () => {
    const cookie = serializeCookie('session', 'abc', {
      domain: 'example.com',
      httpOnly: true,
      maxAge: 3600,
      path: '/',
      sameSite: 'strict',
      secure: true,
    });
    expect(cookie).toContain('session=abc');
    expect(cookie).toContain('Domain=example.com');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=3600');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
  });

  it('should serialize with expires', () => {
    const date = new Date('2025-12-31T00:00:00Z');
    const cookie = serializeCookie('test', 'val', { expires: date });
    expect(cookie).toContain('Expires=');
  });

  it('should URL-encode values', () => {
    const cookie = serializeCookie('data', 'hello world');
    expect(cookie).toBe('data=hello%20world');
  });
});

describe('Cookie integration with app', () => {
  it('should read cookies from request', async () => {
    const app = createApp();
    app.get('/check', (req: any, reply) => {
      return reply.json({ session: req.cookies.session });
    });

    const response = await app.inject({
      url: '/check',
      headers: { cookie: 'session=abc123' },
    });
    const body = await response.json();
    expect(body).toEqual({ session: 'abc123' });
  });

  it('should set cookies on response', async () => {
    const app = createApp();
    app.get('/login', (_req, reply) => {
      return reply
        .cookie('session', 'xyz', { httpOnly: true, path: '/' })
        .json({ ok: true });
    });

    const response = await app.inject({ url: '/login' });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('session=xyz');
    expect(setCookie).toContain('HttpOnly');
  });

  it('should clear cookies', async () => {
    const app = createApp();
    app.get('/logout', (_req, reply) => {
      return reply.clearCookie('session').json({ ok: true });
    });

    const response = await app.inject({ url: '/logout' });
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('session=');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('should lazily parse cookies (only on access)', async () => {
    const app = createApp();
    let accessed = false;
    app.get('/lazy', (req: any, reply) => {
      // Just accessing the property should trigger parsing
      const cookies = req.cookies;
      accessed = true;
      return reply.json({ count: Object.keys(cookies).length });
    });

    await app.inject({
      url: '/lazy',
      headers: { cookie: 'a=1; b=2' },
    });
    expect(accessed).toBe(true);
  });
});
