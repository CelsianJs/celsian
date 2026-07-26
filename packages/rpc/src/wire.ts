// @celsian/rpc, Wire protocol: tagged encoding for native types

import { WireDecodeError } from "./errors.js";
import type { TaggedValue } from "./types.js";

const TAG_DATE = "Date";
const TAG_BIGINT = "BigInt";
const TAG_UNDEFINED = "Undefined";
const TAG_SET = "Set";
const TAG_MAP = "Map";
const TAG_REGEXP = "RegExp";

/**
 * Keys that must never be copied out of a wire payload.
 *
 * `JSON.parse` keeps `__proto__` as an own *enumerable* property, so copying it
 * into a plain `{}` fires `Object.prototype.__proto__`'s setter and silently
 * re-parents the result object. `Object.keys(input)` then omits the injected
 * fields while `input.isAdmin` reads `true`, precisely what defeats allow-list
 * guards written as `Object.keys(input).forEach(...)` or `for…in` +
 * `hasOwnProperty`, and what makes a downstream `{...input}` or ORM write carry
 * attacker-chosen fields.
 *
 * Kept byte-identical to `@celsian/core`'s body-parser scrub. Core only covers
 * the parsed request body, which leaves the RPC `GET ?input=` path and any
 * standalone `RPCHandler.handle()` call unprotected, hence this copy. See the
 * README note about promoting it to a shared core export.
 */
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Maximum object/array nesting `decode()` will walk.
 *
 * Wire input is untrusted and `decode()` is mutually recursive with itself
 * through arrays, objects, and the nested `JSON.parse` inside the `Set`/`Map`
 * tags. Both call sites already turn a native `RangeError` into a clean 400, so
 * this cap is about making the limit explicit and cheap to hit rather than
 * relying on the engine's stack depth.
 */
const MAX_DECODE_DEPTH = 32;

export function encode(value: unknown): unknown {
  if (value === undefined) {
    return { __t: TAG_UNDEFINED, v: "" };
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return { __t: TAG_DATE, v: value.toISOString() } satisfies TaggedValue;
  }
  if (typeof value === "bigint") {
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
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = encode(v);
    }
    return result;
  }
  return value;
}

export function decode(value: unknown): unknown {
  return decodeValue(value, 0);
}

function decodeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }

  if (depth >= MAX_DECODE_DEPTH) {
    throw new WireDecodeError(`RPC input nests deeper than the maximum of ${MAX_DECODE_DEPTH} levels`);
  }

  if (Array.isArray(value)) {
    return value.map((item) => decodeValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;

    if ("__t" in obj && "v" in obj) {
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
          return new Set(parseNested(v, depth).map((item) => decodeValue(item, depth + 1)));
        case TAG_MAP: {
          const entries = parseNested(v, depth).map((entry) => {
            const [k, val] = entry as [unknown, unknown];
            return [decodeValue(k, depth + 1), decodeValue(val, depth + 1)] as [unknown, unknown];
          });
          return new Map(entries);
        }
        case TAG_REGEXP:
          // Security: do NOT construct RegExp from untrusted wire data (ReDoS risk).
          // Return the raw string representation instead.
          return v;
        default:
          return obj;
      }
    }

    // Rebuild by explicit key copy, skipping BLOCKED_KEYS. Assigning a
    // `__proto__` key here would fire the prototype setter (see BLOCKED_KEYS).
    const result: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      if (BLOCKED_KEYS.has(k)) continue;
      result[k] = decodeValue(obj[k], depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * Parse the JSON blob nested inside a `Set`/`Map` tag. That inner `JSON.parse`
 * is a second, independent recursion entry point, so it is depth-accounted and
 * shape-checked here rather than trusted.
 */
function parseNested(raw: string, depth: number): unknown[] {
  if (depth >= MAX_DECODE_DEPTH) {
    throw new WireDecodeError(`RPC input nests deeper than the maximum of ${MAX_DECODE_DEPTH} levels`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new WireDecodeError("Tagged Set/Map payload must encode an array");
  }
  return parsed;
}
