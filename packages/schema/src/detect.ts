// @celsian/schema — Auto-detect schema library by duck-typing

import type { StandardSchema } from './standard.js';
import { fromZod } from './adapters/zod.js';
import { fromTypeBox } from './adapters/typebox.js';
import { fromValibot } from './adapters/valibot.js';

export function fromSchema<T>(schema: any): StandardSchema<T, T> {
  // Zod: has safeParse + parse
  if (typeof schema?.safeParse === 'function' && typeof schema?.parse === 'function') {
    return fromZod<T>(schema);
  }
  // TypeBox: has type + properties (JSON Schema shape)
  if (schema?.type !== undefined && schema?.properties !== undefined) {
    return fromTypeBox<T>(schema);
  }
  // Valibot: has _parse
  if (typeof schema?._parse === 'function') {
    return fromValibot<T>(schema);
  }
  // Already a StandardSchema
  if (typeof schema?.validate === 'function' && typeof schema?.toJsonSchema === 'function') {
    return schema as StandardSchema<T, T>;
  }
  throw new Error(
    'Unsupported schema library. Use Zod, TypeBox, Valibot, or a StandardSchema-compatible schema.',
  );
}
