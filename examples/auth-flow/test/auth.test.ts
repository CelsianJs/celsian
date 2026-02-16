import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthApp } from '../src/index.js';

describe('Auth Flow', () => {
  let app: ReturnType<typeof createAuthApp>;

  beforeEach(async () => {
    app = createAuthApp();
    await app.ready();
  });

  it('should register a new user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'test@example.com', password: 'password123' },
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.user.email).toBe('test@example.com');
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('should reject registration with short password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'test@example.com', password: 'short' },
    });

    expect(response.status).toBe(400);
  });

  it('should reject duplicate email', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'test@example.com', password: 'password123' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'test@example.com', password: 'password456' },
    });

    expect(response.status).toBe(409);
  });

  it('should login with correct credentials', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'login@example.com', password: 'password123' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'login@example.com', password: 'password123' },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('should reject login with wrong password', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'wrong@example.com', password: 'password123' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'wrong@example.com', password: 'wrongpassword' },
    });

    expect(response.status).toBe(401);
  });

  it('should access protected route with valid token', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'protected@example.com', password: 'password123' },
    });
    const { accessToken } = await registerRes.json();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.email).toBe('protected@example.com');
  });

  it('should reject protected route without token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
    });

    expect(response.status).toBe(401);
  });

  it('should refresh tokens', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'refresh@example.com', password: 'password123' },
    });
    const { refreshToken } = await registerRes.json();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    // Refresh token should be rotated
    expect(body.refreshToken).not.toBe(refreshToken);
  });

  it('should invalidate old refresh token after rotation', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'rotate@example.com', password: 'password123' },
    });
    const { refreshToken } = await registerRes.json();

    // Use refresh token
    await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });

    // Try to use old refresh token again
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });

    expect(response.status).toBe(401);
  });

  it('should logout by invalidating refresh token', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'logout@example.com', password: 'password123' },
    });
    const { refreshToken } = await registerRes.json();

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken },
    });
    expect(logoutRes.status).toBe(200);

    // Refresh should fail
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    expect(refreshRes.status).toBe(401);
  });
});
