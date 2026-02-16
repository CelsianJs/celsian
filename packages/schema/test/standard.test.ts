import { describe, it, expect } from 'vitest';
import type { StandardSchema, SchemaResult } from '../src/standard.js';

describe('StandardSchema interface', () => {
  it('should define a valid StandardSchema', () => {
    const schema: StandardSchema<string> = {
      validate(input: unknown): SchemaResult<string> {
        if (typeof input === 'string') {
          return { success: true, data: input };
        }
        return { success: false, issues: [{ message: 'Expected string' }] };
      },
      toJsonSchema() {
        return { type: 'string' };
      },
      _input: undefined as unknown as string,
      _output: undefined as unknown as string,
    };

    const result = schema.validate('hello');
    expect(result.success).toBe(true);
    expect(result.data).toBe('hello');
  });

  it('should return issues on validation failure', () => {
    const schema: StandardSchema<number> = {
      validate(input: unknown): SchemaResult<number> {
        if (typeof input === 'number') {
          return { success: true, data: input };
        }
        return { success: false, issues: [{ message: 'Expected number', path: ['value'] }] };
      },
      toJsonSchema() {
        return { type: 'number' };
      },
      _input: undefined as unknown as number,
      _output: undefined as unknown as number,
    };

    const result = schema.validate('not a number');
    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues![0].message).toBe('Expected number');
    expect(result.issues![0].path).toEqual(['value']);
  });
});
