// @celsian/cache — Session tests

import { describe, it, expect, vi } from 'vitest';
import { MemoryKVStore } from '../src/store.js';
import { createSessionManager } from '../src/session.js';

describe('Session Manager', () => {
  function makeManager(opts?: { ttlMs?: number }) {
    const store = new MemoryKVStore({ cleanupIntervalMs: 0 });
    const manager = createSessionManager({ store, ...opts });
    return { store, manager };
  }

  it('creates a new session', async () => {
    const { manager } = makeManager();

    const session = await manager.create();
    expect(session.id).toBeTruthy();
    expect(session.id.length).toBeGreaterThan(20);
  });

  it('stores and retrieves session data', async () => {
    const { manager } = makeManager();

    const session = await manager.create();
    session.set('user', { name: 'Alice' });
    session.set('role', 'admin');
    await session.save();

    const loaded = await manager.load(session.id);
    expect(loaded).toBeDefined();
    expect(loaded!.get('user')).toEqual({ name: 'Alice' });
    expect(loaded!.get('role')).toBe('admin');
  });

  it('all() returns a copy of session data', async () => {
    const { manager } = makeManager();

    const session = await manager.create();
    session.set('a', 1);
    session.set('b', 2);
    await session.save();

    const loaded = await manager.load(session.id);
    const data = loaded!.all();
    expect(data).toEqual({ a: 1, b: 2 });

    // Modifying the returned object doesn't affect the session
    data.c = 3;
    expect(loaded!.get('c')).toBeUndefined();
  });

  it('delete removes a session key', async () => {
    const { manager } = makeManager();

    const session = await manager.create();
    session.set('temp', 'value');
    session.delete('temp');
    await session.save();

    const loaded = await manager.load(session.id);
    expect(loaded!.get('temp')).toBeUndefined();
  });

  it('destroy removes the session from store', async () => {
    const { manager } = makeManager();

    const session = await manager.create();
    session.set('data', 'important');
    await session.save();

    await session.destroy();

    const loaded = await manager.load(session.id);
    expect(loaded).toBeUndefined();
  });

  it('regenerate creates a new session ID', async () => {
    const { manager } = makeManager();

    const session = await manager.create();
    session.set('user', 'Alice');
    await session.save();

    const oldId = session.id;
    const newSession = await session.regenerate();

    expect(newSession.id).not.toBe(oldId);
    expect(newSession.get('user')).toBe('Alice');

    // Old session should be destroyed
    const oldLoaded = await manager.load(oldId);
    expect(oldLoaded).toBeUndefined();

    // New session should exist
    const newLoaded = await manager.load(newSession.id);
    expect(newLoaded).toBeDefined();
    expect(newLoaded!.get('user')).toBe('Alice');
  });

  it('load returns undefined for nonexistent sessions', async () => {
    const { manager } = makeManager();
    const loaded = await manager.load('nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('respects session TTL', async () => {
    vi.useFakeTimers();
    try {
      const { manager } = makeManager({ ttlMs: 100 });

      const session = await manager.create();
      session.set('data', 'temp');
      await session.save();

      // Within TTL
      let loaded = await manager.load(session.id);
      expect(loaded).toBeDefined();

      // After TTL
      vi.advanceTimersByTime(101);
      loaded = await manager.load(session.id);
      expect(loaded).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fromRequest loads session from cookie', async () => {
    const { manager } = makeManager();

    // Create a session first
    const session = await manager.create();
    session.set('user', 'Bob');
    await session.save();

    // Simulate a request with the session cookie
    const request = new Request('http://localhost/profile', {
      headers: { cookie: `sid=${session.id}; other=value` },
    });

    const loaded = await manager.fromRequest(request);
    expect(loaded.id).toBe(session.id);
    expect(loaded.get('user')).toBe('Bob');
  });

  it('fromRequest creates new session when no cookie', async () => {
    const { manager } = makeManager();

    const request = new Request('http://localhost/profile');
    const session = await manager.fromRequest(request);

    expect(session.id).toBeTruthy();
    expect(session.all()).toEqual({});
  });

  it('fromRequest creates new session when cookie is invalid', async () => {
    const { manager } = makeManager();

    const request = new Request('http://localhost/profile', {
      headers: { cookie: 'sid=invalid-session-id' },
    });

    const session = await manager.fromRequest(request);
    expect(session.id).not.toBe('invalid-session-id');
  });

  it('cookie generates a Set-Cookie header', () => {
    const { manager } = makeManager();

    const cookie = manager.cookie('abc123');
    expect(cookie).toContain('sid=abc123');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=');
  });

  it('cookie respects options', () => {
    const { manager } = makeManager();

    const cookie = manager.cookie('abc', {
      secure: true,
      sameSite: 'Strict',
      httpOnly: false,
    });

    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('HttpOnly');
  });

  it('destroy by ID removes session', async () => {
    const { manager } = makeManager();

    const session = await manager.create();
    await session.save();

    await manager.destroy(session.id);

    const loaded = await manager.load(session.id);
    expect(loaded).toBeUndefined();
  });
});
