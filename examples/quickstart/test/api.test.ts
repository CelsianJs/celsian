import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { resetTodos } from '../src/routes/todos.js';
import { resetUsers } from '../src/routes/auth.js';

// Helper: create a fresh app instance for each test
function createTestApp() {
  resetTodos();
  resetUsers();
  return buildApp();
}

// ─── Todo CRUD ───

describe('Todo CRUD', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = createTestApp();
    await app.ready();
  });

  it('GET /todos returns an empty list initially', async () => {
    const res = await app.inject({ url: '/todos' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('POST /todos creates a todo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/todos',
      payload: { title: 'Buy milk' },
    });
    expect(res.status).toBe(201);

    const todo = await res.json();
    expect(todo.title).toBe('Buy milk');
    expect(todo.completed).toBe(false);
    expect(todo.id).toBeDefined();
    expect(todo.createdAt).toBeDefined();
  });

  it('GET /todos/:id returns a single todo', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/todos',
      payload: { title: 'Read docs' },
    });
    const { id } = await createRes.json();

    const res = await app.inject({ url: `/todos/${id}` });
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe('Read docs');
  });

  it('GET /todos/:id returns 404 for missing todo', async () => {
    const res = await app.inject({ url: '/todos/999' });
    expect(res.status).toBe(404);
  });

  it('PUT /todos/:id updates a todo', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/todos',
      payload: { title: 'Original' },
    });
    const { id } = await createRes.json();

    const res = await app.inject({
      method: 'PUT',
      url: `/todos/${id}`,
      payload: { title: 'Updated', completed: true },
    });
    expect(res.status).toBe(200);

    const todo = await res.json();
    expect(todo.title).toBe('Updated');
    expect(todo.completed).toBe(true);
  });

  it('PUT /todos/:id returns 404 for missing todo', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/todos/999',
      payload: { title: 'Nope' },
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /todos/:id removes a todo', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/todos',
      payload: { title: 'Delete me' },
    });
    const { id } = await createRes.json();

    const delRes = await app.inject({ method: 'DELETE', url: `/todos/${id}` });
    expect(delRes.status).toBe(204);

    // Confirm it's gone
    const getRes = await app.inject({ url: `/todos/${id}` });
    expect(getRes.status).toBe(404);
  });

  it('DELETE /todos/:id returns 404 for missing todo', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/todos/999' });
    expect(res.status).toBe(404);
  });

  it('POST /todos with empty title returns validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/todos',
      payload: { title: '' },
    });
    expect(res.status).toBe(400);
  });

  it('GET /todos lists multiple todos', async () => {
    await app.inject({ method: 'POST', url: '/todos', payload: { title: 'First' } });
    await app.inject({ method: 'POST', url: '/todos', payload: { title: 'Second' } });

    const res = await app.inject({ url: '/todos' });
    const list = await res.json();
    expect(list).toHaveLength(2);
    expect(list[0].title).toBe('First');
    expect(list[1].title).toBe('Second');
  });
});

// ─── Auth Flow ───

describe('Auth', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = createTestApp();
    await app.ready();
  });

  it('POST /auth/register creates a user and returns a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'alice@example.com', password: 'securepass' },
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.user.email).toBe('alice@example.com');
    expect(body.token).toBeDefined();
  });

  it('POST /auth/register rejects short passwords', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'bob@example.com', password: 'short' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /auth/register rejects duplicate emails', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'dup@example.com', password: 'password123' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'dup@example.com', password: 'password456' },
    });
    expect(res.status).toBe(409);
  });

  it('POST /auth/login returns a token for valid credentials', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'login@example.com', password: 'password123' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'login@example.com', password: 'password123' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBeDefined();
  });

  it('POST /auth/login rejects wrong password', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'wrong@example.com', password: 'password123' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'wrong@example.com', password: 'badpassword' },
    });
    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns profile with valid token', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'me@example.com', password: 'password123' },
    });
    const { token } = await registerRes.json();

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.email).toBe('me@example.com');
    expect(body.createdAt).toBeDefined();
  });

  it('GET /auth/me returns 401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns 401 with an invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer invalid.token.here' },
    });
    expect(res.status).toBe(401);
  });
});

// ─── Health Check ───

describe('Health', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = createTestApp();
    await app.ready();
  });

  it('GET /health returns ok', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('GET /ready returns ready', async () => {
    const res = await app.inject({ url: '/ready' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
  });
});
