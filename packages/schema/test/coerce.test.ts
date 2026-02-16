import { describe, it, expect } from 'vitest';
import { coerceString, coerceQueryParams } from '../src/coerce.js';

describe('coerceString', () => {
  it('should coerce string to number', () => {
    expect(coerceString('42', 'number')).toBe(42);
    expect(coerceString('3.14', 'number')).toBe(3.14);
    expect(coerceString('-10', 'number')).toBe(-10);
    expect(coerceString('0', 'number')).toBe(0);
  });

  it('should throw for invalid number', () => {
    expect(() => coerceString('abc', 'number')).toThrow('Cannot coerce "abc" to number');
  });

  it('should coerce string to boolean', () => {
    expect(coerceString('true', 'boolean')).toBe(true);
    expect(coerceString('1', 'boolean')).toBe(true);
    expect(coerceString('false', 'boolean')).toBe(false);
    expect(coerceString('0', 'boolean')).toBe(false);
    expect(coerceString('', 'boolean')).toBe(false);
  });

  it('should throw for invalid boolean', () => {
    expect(() => coerceString('yes', 'boolean')).toThrow('Cannot coerce "yes" to boolean');
  });

  it('should coerce string to date', () => {
    const date = coerceString('2026-01-15', 'date') as Date;
    expect(date).toBeInstanceOf(Date);
    expect(date.getFullYear()).toBe(2026);
  });

  it('should throw for invalid date', () => {
    expect(() => coerceString('not-a-date', 'date')).toThrow('Cannot coerce "not-a-date" to Date');
  });

  it('should return string as-is for unknown type', () => {
    expect(coerceString('hello', 'string')).toBe('hello');
    expect(coerceString('hello', 'unknown')).toBe('hello');
  });
});

describe('coerceQueryParams', () => {
  it('should coerce multiple query params', () => {
    const result = coerceQueryParams(
      { page: '1', limit: '10', active: 'true', name: 'john' },
      { page: 'number', limit: 'number', active: 'boolean', name: 'string' },
    );

    expect(result).toEqual({
      page: 1,
      limit: 10,
      active: true,
      name: 'john',
    });
  });

  it('should leave unspecified params as strings', () => {
    const result = coerceQueryParams(
      { page: '1', extra: 'value' },
      { page: 'number' },
    );

    expect(result).toEqual({
      page: 1,
      extra: 'value',
    });
  });
});
