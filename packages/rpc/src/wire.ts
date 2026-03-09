// @celsian/rpc — Wire protocol: tagged encoding for native types

import type { TaggedValue } from './types.js';

const TAG_DATE = 'Date';
const TAG_BIGINT = 'BigInt';
const TAG_UNDEFINED = 'Undefined';
const TAG_SET = 'Set';
const TAG_MAP = 'Map';
const TAG_REGEXP = 'RegExp';

export function encode(value: unknown): unknown {
  if (value === undefined) {
    return { __t: TAG_UNDEFINED, v: '' };
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return { __t: TAG_DATE, v: value.toISOString() } satisfies TaggedValue;
  }
  if (typeof value === 'bigint') {
    return { __t: TAG_BIGINT, v: value.toString() } satisfies TaggedValue;
  }
  if (value instanceof Set) {
    return { __t: TAG_SET, v: JSON.stringify([...value].map(encode)) };
  }
  if (value instanceof Map) {
    return { __t: TAG_MAP, v: JSON.stringify([...value.entries()].map(([k, v]) => [encode(k), encode(v)])) };
  }
  if (value instanceof RegExp) {
    return { __t: TAG_REGEXP, v: value.toString() } satisfies TaggedValue;
  }
  if (Array.isArray(value)) {
    return value.map(encode);
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = encode(v);
    }
    return result;
  }
  return value;
}

export function decode(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decode);
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;

    if ('__t' in obj && 'v' in obj) {
      const tag = obj.__t as string;
      const v = obj.v as string;

      switch (tag) {
        case TAG_DATE:
          return new Date(v);
        case TAG_BIGINT:
          return BigInt(v);
        case TAG_UNDEFINED:
          return undefined;
        case TAG_SET:
          return new Set((JSON.parse(v) as unknown[]).map(decode));
        case TAG_MAP: {
          const entries = (JSON.parse(v) as [unknown, unknown][]).map(
            ([k, val]) => [decode(k), decode(val)] as [unknown, unknown],
          );
          return new Map(entries);
        }
        case TAG_REGEXP: {
          // Use lastIndexOf to avoid ReDoS with crafted patterns
          const lastSlash = v.lastIndexOf('/');
          if (lastSlash > 0 && v.charCodeAt(0) === 47 /* '/' */) {
            const pattern = v.slice(1, lastSlash);
            const flags = v.slice(lastSlash + 1);
            // Validate flags contain only valid characters
            if (/^[gimsuy]*$/.test(flags)) {
              return new RegExp(pattern, flags);
            }
          }
          return new RegExp(v);
        }
        default:
          return obj;
      }
    }

    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) {
      result[k] = decode(val);
    }
    return result;
  }
  return value;
}
