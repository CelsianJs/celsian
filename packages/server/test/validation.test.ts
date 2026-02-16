// @celsian/server — Tests for schema validation integration

import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

function makeRequest(url: string, method = 'GET', body?: unknown): Request {
  const init: RequestInit = { method };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(`http://localhost${url}`, init);
}

// Mock StandardSchema-compatible validator
function createMockSchema(validator: (input: unknown) => boolean) {
  return {
    validate(input: unknown) {
      if (validator(input)) {
        return { success: true, data: input };
      }
      return {
        success: false,
        issues: [{ message: 'Validation failed', path: ['field'] as (string | number)[] }],
      };
    },
    toJsonSchema: () => ({ type: 'object' }),
  };
}

describe('Schema Validation Integration', () => {
  it('should validate body schema on POST routes', async () => {
    const bodySchema = createMockSchema(
      (input) => typeof input === 'object' && input !== null && 'name' in input,
    );

    const app = createApp();
    app.route({
      method: 'POST',
      url: '/users',
      schema: { body: bodySchema },
      handler: (req, reply) => reply.status(201).json({ created: true }),
    });

    // Valid body
    const validResponse = await app.handle(makeRequest('/users', 'POST', { name: 'Alice' }));
    expect(validResponse.status).toBe(201);

    // Invalid body
    const invalidResponse = await app.handle(makeRequest('/users', 'POST', { foo: 'bar' }));
    expect(invalidResponse.status).toBe(400);
    const data = await invalidResponse.json();
    expect(data.error).toBe('Validation Error');
    expect(data.issues).toBeDefined();
    expect(data.issues.length).toBeGreaterThan(0);
  });

  it('should validate querystring schema', async () => {
    const qsSchema = createMockSchema(
      (input) => typeof input === 'object' && input !== null && 'q' in input,
    );

    const app = createApp();
    app.route({
      method: 'GET',
      url: '/search',
      schema: { querystring: qsSchema },
      handler: (req, reply) => reply.json({ results: [] }),
    });

    // Valid query
    const validResponse = await app.handle(makeRequest('/search?q=hello'));
    expect(validResponse.status).toBe(200);

    // Invalid query (no 'q' param)
    const invalidResponse = await app.handle(makeRequest('/search?foo=bar'));
    expect(invalidResponse.status).toBe(400);
  });

  it('should validate params schema', async () => {
    const paramsSchema = createMockSchema(
      (input) => {
        if (typeof input !== 'object' || input === null) return false;
        const id = (input as Record<string, string>).id;
        return typeof id === 'string' && /^\d+$/.test(id);
      },
    );

    const app = createApp();
    app.route({
      method: 'GET',
      url: '/users/:id',
      schema: { params: paramsSchema },
      handler: (req, reply) => reply.json({ id: req.params.id }),
    });

    // Valid param (numeric)
    const validResponse = await app.handle(makeRequest('/users/42'));
    expect(validResponse.status).toBe(200);

    // Invalid param (non-numeric) — this depends on schema, not routing
    const invalidResponse = await app.handle(makeRequest('/users/abc'));
    expect(invalidResponse.status).toBe(400);
  });

  it('should run validation before handler', async () => {
    const order: string[] = [];
    const bodySchema = createMockSchema(() => {
      order.push('validate');
      return false; // Always fail
    });

    const app = createApp();
    app.route({
      method: 'POST',
      url: '/test',
      schema: { body: bodySchema },
      handler: (req, reply) => {
        order.push('handler');
        return reply.json({ ok: true });
      },
    });

    await app.handle(makeRequest('/test', 'POST', { data: 'test' }));
    expect(order).toEqual(['validate']);
    expect(order).not.toContain('handler');
  });

  it('should skip validation when no schema is defined', async () => {
    const app = createApp();
    app.post('/test', (req, reply) => reply.json({ ok: true }));

    const response = await app.handle(makeRequest('/test', 'POST', { anything: 'goes' }));
    expect(response.status).toBe(200);
  });
});
