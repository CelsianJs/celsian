import { describe, it, expect } from 'vitest';
import {
  CelsianError,
  HttpError,
  ValidationError,
  assertPlugin,
  assertDecorationUnique,
  wrapNonError,
} from '../src/errors.js';
import { createApp } from '../src/app.js';

// ─── CelsianError ───

describe('CelsianError', () => {
  it('should be an instance of Error', () => {
    const err = new CelsianError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CelsianError);
    expect(err.name).toBe('CelsianError');
    expect(err.message).toBe('test');
  });
});

// ─── HttpError ───

describe('HttpError', () => {
  it('should use default message for known status codes', () => {
    expect(new HttpError(404).message).toBe('Not Found');
    expect(new HttpError(401).message).toBe('Unauthorized');
    expect(new HttpError(500).message).toBe('Internal Server Error');
  });

  it('should accept custom message', () => {
    const err = new HttpError(404, 'User not found');
    expect(err.message).toBe('User not found');
    expect(err.statusCode).toBe(404);
  });

  it('should serialize to JSON with code', () => {
    const err = new HttpError(403, 'Forbidden');
    const json = err.toJSON();
    expect(json.error).toBe('Forbidden');
    expect(json.statusCode).toBe(403);
    expect(json.code).toBe('FORBIDDEN');
  });

  it('should auto-derive code from status code', () => {
    expect(new HttpError(400).code).toBe('BAD_REQUEST');
    expect(new HttpError(401).code).toBe('UNAUTHORIZED');
    expect(new HttpError(404).code).toBe('NOT_FOUND');
    expect(new HttpError(413).code).toBe('PAYLOAD_TOO_LARGE');
    expect(new HttpError(429).code).toBe('TOO_MANY_REQUESTS');
    expect(new HttpError(500).code).toBe('INTERNAL_SERVER_ERROR');
    expect(new HttpError(504).code).toBe('GATEWAY_TIMEOUT');
  });

  it('should accept custom code', () => {
    const err = new HttpError(400, 'Bad email', { code: 'INVALID_EMAIL' });
    expect(err.code).toBe('INVALID_EMAIL');
  });

  it('should accept cause', () => {
    const cause = new Error('original');
    const err = new HttpError(500, 'Wrapper', { cause });
    expect(err.cause).toBe(cause);
  });

  it('should be catchable as CelsianError', () => {
    const err = new HttpError(500);
    expect(err).toBeInstanceOf(CelsianError);
  });

  it('should include stack in dev mode', () => {
    const err = new HttpError(404);
    const json = err.toJSON();
    // In test env (not production), stack should be included
    expect(json.stack).toBeDefined();
  });
});

// ─── ValidationError ───

describe('ValidationError', () => {
  it('should hold issues', () => {
    const err = new ValidationError([
      { message: 'Required', path: ['name'] },
      { message: 'Invalid email', path: ['email'] },
    ]);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.issues).toHaveLength(2);
  });

  it('should serialize to JSON with code', () => {
    const err = new ValidationError([{ message: 'Required' }]);
    const json = err.toJSON();
    expect(json.statusCode).toBe(400);
    expect(json.code).toBe('VALIDATION_FAILED');
    expect(json.issues).toHaveLength(1);
  });

  it('should format message as a human-readable bulleted list', () => {
    const err = new ValidationError([
      { message: 'required field', path: ['body', 'email'] },
      { message: 'must be at least 8 characters', path: ['body', 'password'] },
    ]);
    expect(err.message).toBe(
      'Validation failed: \u2022 body.email: required field \u2022 body.password: must be at least 8 characters',
    );
  });

  it('should handle issues without a path', () => {
    const err = new ValidationError([
      { message: 'is required' },
    ]);
    expect(err.message).toBe('Validation failed: \u2022 is required');
  });

  it('should handle empty issues array', () => {
    const err = new ValidationError([]);
    expect(err.message).toBe('Validation failed');
  });

  it('should include human-readable message in toJSON()', () => {
    const err = new ValidationError([
      { message: 'required field', path: ['email'] },
    ]);
    const json = err.toJSON();
    expect(json.message).toBe('Validation failed: \u2022 email: required field');
    expect(json.error).toBe('Validation failed');
    expect(json.issues).toHaveLength(1);
  });

  it('should handle numeric path segments', () => {
    const err = new ValidationError([
      { message: 'invalid value', path: ['items', 0, 'name'] },
    ]);
    expect(err.message).toBe('Validation failed: \u2022 items.0.name: invalid value');
  });
});

// ─── assertPlugin ───

describe('assertPlugin', () => {
  it('should not throw for a function', () => {
    expect(() => assertPlugin(() => {})).not.toThrow();
    expect(() => assertPlugin(async () => {})).not.toThrow();
    expect(() => assertPlugin(function myPlugin() {})).not.toThrow();
  });

  it('should throw for a string', () => {
    expect(() => assertPlugin('not a function')).toThrow(CelsianError);
    expect(() => assertPlugin('not a function')).toThrow(
      /app\.register\(\) expects a plugin function, but received string \(not a function\)/,
    );
  });

  it('should throw for a number', () => {
    expect(() => assertPlugin(42)).toThrow(CelsianError);
    expect(() => assertPlugin(42)).toThrow(/received number \(42\)/);
  });

  it('should throw for null', () => {
    expect(() => assertPlugin(null)).toThrow(CelsianError);
    expect(() => assertPlugin(null)).toThrow(/received null/);
  });

  it('should throw for an object and show preview', () => {
    expect(() => assertPlugin({ name: 'test' })).toThrow(CelsianError);
    expect(() => assertPlugin({ name: 'test' })).toThrow(/received an Object/);
  });

  it('should throw for an array', () => {
    expect(() => assertPlugin([1, 2, 3])).toThrow(CelsianError);
    expect(() => assertPlugin([1, 2, 3])).toThrow(/received an Array/);
  });

  it('should throw for undefined', () => {
    expect(() => assertPlugin(undefined)).toThrow(CelsianError);
    expect(() => assertPlugin(undefined)).toThrow(/received undefined/);
  });

  it('should suggest the correct usage pattern', () => {
    expect(() => assertPlugin('oops')).toThrow(
      /Usage: app\.register\(async \(app, opts\) => \{ \/\* \.\.\. \*\/ \}\)/,
    );
  });
});

// ─── assertDecorationUnique ───

describe('assertDecorationUnique', () => {
  it('should throw showing both existing and new values', () => {
    expect(() => assertDecorationUnique('db', 'postgres-pool', 'mysql-pool')).toThrow(CelsianError);
    expect(() => assertDecorationUnique('db', 'postgres-pool', 'mysql-pool')).toThrow(
      /Decoration "db" already exists/,
    );
    expect(() => assertDecorationUnique('db', 'postgres-pool', 'mysql-pool')).toThrow(
      /Existing value: postgres-pool/,
    );
    expect(() => assertDecorationUnique('db', 'postgres-pool', 'mysql-pool')).toThrow(
      /new value: mysql-pool/,
    );
  });

  it('should format function values with their name', () => {
    function existingHelper() {}
    function newHelper() {}
    expect(() => assertDecorationUnique('helper', existingHelper, newHelper)).toThrow(
      /Existing value: \[Function: existingHelper\]/,
    );
    expect(() => assertDecorationUnique('helper', existingHelper, newHelper)).toThrow(
      /new value: \[Function: newHelper\]/,
    );
  });

  it('should format object values as JSON', () => {
    expect(() => assertDecorationUnique('config', { a: 1 }, { b: 2 })).toThrow(
      /Existing value: \{"a":1\}/,
    );
  });

  it('should suggest using a unique name', () => {
    expect(() => assertDecorationUnique('x', 1, 2)).toThrow(
      /Use a unique name or remove the conflicting plugin/,
    );
  });
});

// ─── wrapNonError ───

describe('wrapNonError', () => {
  it('should return Error instances unchanged', () => {
    const original = new Error('original');
    expect(wrapNonError(original)).toBe(original);
  });

  it('should return HttpError instances unchanged', () => {
    const original = new HttpError(404);
    expect(wrapNonError(original)).toBe(original);
  });

  it('should wrap a thrown string', () => {
    const wrapped = wrapNonError('something went wrong');
    expect(wrapped).toBeInstanceOf(CelsianError);
    expect(wrapped.message).toContain('non-Error value');
    expect(wrapped.message).toContain('"something went wrong"');
    expect(wrapped.message).toContain('throw new HttpError(500, "your message")');
  });

  it('should wrap a thrown number', () => {
    const wrapped = wrapNonError(42);
    expect(wrapped).toBeInstanceOf(CelsianError);
    expect(wrapped.message).toContain('number');
    expect(wrapped.message).toContain('42');
  });

  it('should wrap null', () => {
    const wrapped = wrapNonError(null);
    expect(wrapped).toBeInstanceOf(CelsianError);
    expect(wrapped.message).toContain('null');
  });

  it('should wrap undefined', () => {
    const wrapped = wrapNonError(undefined);
    expect(wrapped).toBeInstanceOf(CelsianError);
    expect(wrapped.message).toContain('undefined');
  });

  it('should truncate long strings', () => {
    const longStr = 'x'.repeat(200);
    const wrapped = wrapNonError(longStr);
    expect(wrapped.message).toContain('...');
    // The preview should be truncated to 80 chars + "..."
    expect(wrapped.message.length).toBeLessThan(300);
  });
});

// ─── Integration: app.register() with non-function ───

describe('app.register() with non-function', () => {
  it('should throw CelsianError when registering a string', async () => {
    const app = createApp();
    await expect(app.register('not-a-plugin' as any)).rejects.toThrow(CelsianError);
    await expect(app.register('not-a-plugin' as any)).rejects.toThrow(
      /app\.register\(\) expects a plugin function/,
    );
  });

  it('should throw CelsianError when registering an object', async () => {
    const app = createApp();
    await expect(app.register({ name: 'plugin' } as any)).rejects.toThrow(CelsianError);
  });

  it('should throw CelsianError when registering null', async () => {
    const app = createApp();
    await expect(app.register(null as any)).rejects.toThrow(/received null/);
  });
});

// ─── Integration: malformed JSON body includes content-type ───

describe('malformed JSON body parsing', () => {
  it('should include content-type in the error message', async () => {
    const app = createApp();
    app.post('/test', (_req, reply) => reply.json({ ok: true }));

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: undefined,
    });

    // Send raw malformed JSON via a manual request
    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{invalid json!!!',
    });

    const response = await app.handle(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INVALID_JSON');
    expect(body.error).toContain('content-type: application/json; charset=utf-8');
  });
});

// ─── Integration: decoration conflict ───

describe('decoration conflict', () => {
  it('should throw when decorating with a name that already exists', async () => {
    const app = createApp();
    app.decorate('db', 'pool-1');
    expect(() => app.decorate('db', 'pool-2')).toThrow(CelsianError);
    expect(() => app.decorate('db', 'pool-2')).toThrow(/Decoration "db" already exists/);
  });

  it('should throw in plugin context with conflicting decorations', async () => {
    const app = createApp();
    app.decorate('service', { type: 'original' });

    await expect(
      app.register(async (pluginApp) => {
        pluginApp.decorate('service', { type: 'duplicate' });
      }, { encapsulate: false }),
    ).rejects.toThrow(/Decoration "service" already exists/);
  });
});

// ─── Integration: non-Error thrown from route handler ───

describe('non-Error thrown from route handler', () => {
  it('should wrap a thrown string into CelsianError with helpful message', async () => {
    const app = createApp();
    app.get('/throw-string', () => {
      throw 'something went wrong';
    });

    const res = await app.inject({ method: 'GET', url: '/throw-string' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('non-Error value');
    expect(body.error).toContain('"something went wrong"');
    expect(body.error).toContain('throw new HttpError(500, "your message")');
  });

  it('should wrap a thrown number into CelsianError', async () => {
    const app = createApp();
    app.get('/throw-number', () => {
      throw 42;
    });

    const res = await app.inject({ method: 'GET', url: '/throw-number' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('number');
    expect(body.error).toContain('42');
  });

  it('should wrap null thrown from handler', async () => {
    const app = createApp();
    app.get('/throw-null', () => {
      throw null;
    });

    const res = await app.inject({ method: 'GET', url: '/throw-null' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('null');
  });

  it('should not wrap actual Error instances', async () => {
    const app = createApp();
    app.get('/throw-error', () => {
      throw new HttpError(418, 'I am a teapot');
    });

    const res = await app.inject({ method: 'GET', url: '/throw-error' });
    expect(res.status).toBe(418);
    const body = await res.json();
    expect(body.error).toBe('I am a teapot');
  });
});
