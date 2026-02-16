import { describe, it, expect } from 'vitest';
import { fromZod } from '../src/adapters/zod.js';
import { fromValibot } from '../src/adapters/valibot.js';

describe('fromZod', () => {
  it('should validate successfully with Zod-like schema', () => {
    const zodLike = {
      safeParse(input: unknown) {
        if (typeof input === 'string') {
          return { success: true, data: input };
        }
        return {
          success: false,
          error: {
            issues: [{ message: 'Expected string', path: [] }],
          },
        };
      },
    };

    const schema = fromZod<string>(zodLike);
    const result = schema.validate('hello');
    expect(result.success).toBe(true);
    expect(result.data).toBe('hello');
  });

  it('should return issues on Zod validation failure', () => {
    const zodLike = {
      safeParse() {
        return {
          success: false,
          error: {
            issues: [
              { message: 'Required', path: ['name'] },
              { message: 'Invalid email', path: ['email'] },
            ],
          },
        };
      },
    };

    const schema = fromZod(zodLike);
    const result = schema.validate({});
    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues![0].message).toBe('Required');
    expect(result.issues![1].path).toEqual(['email']);
  });

  it('should return fallback JSON Schema', () => {
    const zodLike = { safeParse: () => ({ success: true, data: null }) };
    const schema = fromZod(zodLike);
    expect(schema.toJsonSchema()).toEqual({ type: 'object' });
  });

  it('should use toJsonSchema if available', () => {
    const zodLike = {
      safeParse: () => ({ success: true, data: null }),
      toJsonSchema: () => ({ type: 'string', minLength: 1 }),
    };
    const schema = fromZod(zodLike);
    expect(schema.toJsonSchema()).toEqual({ type: 'string', minLength: 1 });
  });
});

describe('fromValibot', () => {
  it('should validate with _parse', () => {
    const valibotLike = {
      _parse(input: unknown) {
        return { success: true, output: input };
      },
    };

    const schema = fromValibot(valibotLike);
    const result = schema.validate({ foo: 'bar' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ foo: 'bar' });
  });

  it('should validate with safeParse', () => {
    const valibotLike = {
      safeParse(input: unknown) {
        return { success: true, data: input };
      },
    };

    const schema = fromValibot(valibotLike);
    const result = schema.validate('test');
    expect(result.success).toBe(true);
  });

  it('should handle validation errors', () => {
    const valibotLike = {
      _parse() {
        return {
          success: false,
          issues: [{ message: 'Invalid', path: [{ key: 'name' }] }],
        };
      },
    };

    const schema = fromValibot(valibotLike);
    const result = schema.validate(null);
    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues![0].path).toEqual(['name']);
  });

  it('should handle unknown schema format', () => {
    const schema = fromValibot({});
    const result = schema.validate('test');
    expect(result.success).toBe(false);
  });
});
