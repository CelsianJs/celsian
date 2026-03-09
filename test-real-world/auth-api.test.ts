import { describe, it, expect, beforeEach } from 'vitest';
import { buildAuthApp, tokens } from './auth-api.js';

describe('Auth API', () => {
  let app: ReturnType<typeof buildAuthApp>;

  beforeEach(() => {
    app = buildAuthApp();
    tokens.clear();
  });

  // ─── Public Routes ───

  it('public route is accessible without auth', async () => {
    const res = await app.inject({ url: '/public' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'This is public' });
  });

  // ─── Login ───

  it('login returns a token for valid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeDefined();
    expect(body.token).toMatch(/^tok_/);
    expect(body.expiresIn).toBe(3600);
  });

  it('login rejects invalid password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { username: 'admin', password: 'wrong' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('login rejects missing credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: {},
    });
    expect(res.status).toBe(400);
  });

  // ─── Protected Routes ───

  it('profile requires auth header', async () => {
    const res = await app.inject({ url: '/api/profile' });
    expect(res.status).toBe(401);
  });

  it('profile rejects invalid token', async () => {
    const res = await app.inject({
      url: '/api/profile',
      headers: { authorization: 'Bearer invalid_token' },
    });
    expect(res.status).toBe(401);
  });

  it('profile returns user data with valid token', async () => {
    // Login first
    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { username: 'user1', password: 'pass456' },
    });
    const { token } = await loginRes.json();

    const res = await app.inject({
      url: '/api/profile',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe('user1');
    expect(body.role).toBe('user');
  });

  // ─── Role-based access ───

  it('admin route rejects non-admin users', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { username: 'user1', password: 'pass456' },
    });
    const { token } = await loginRes.json();

    const res = await app.inject({
      url: '/api/admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN');
  });

  it('admin route allows admin users', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    const { token } = await loginRes.json();

    const res = await app.inject({
      url: '/api/admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('Admin area');
  });

  // ─── Encapsulation ───

  it('auth hook does NOT apply to public routes', async () => {
    // Public route should work even though protected plugin has auth hook
    const res = await app.inject({ url: '/public' });
    expect(res.status).toBe(200);
  });

  it('auth hook DOES apply to all /api routes', async () => {
    const res = await app.inject({ url: '/api/profile' });
    expect(res.status).toBe(401);
  });
});
