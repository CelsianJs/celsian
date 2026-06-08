// @celsian/core — Cookie parsing and serialization

import { CelsianError } from "./errors.js";

export interface CookieOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: "strict" | "lax" | "none";
  secure?: boolean;
}

// Keys that must never be set via user input (prototype pollution prevention)
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  if (!header) return cookies;

  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key && !BLOCKED_KEYS.has(key)) {
      // Malformed percent-escapes (e.g. `%ZZ`) throw URIError — fall back to the
      // raw value rather than letting one bad cookie crash request parsing.
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
  }

  return cookies;
}

// Characters that are illegal in cookie names (RFC 6265 token separators) and
// enable header-injection. Avoid control-char regex literals (biome) by
// checking char codes directly.
const NAME_SEPARATORS = new Set('()<>@,;:\\"/[]?={} \t'.split(""));

/** True if a string contains a control char (incl. CR/LF) or DEL. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** True if a cookie name contains illegal token characters. */
function isInvalidCookieName(name: string): boolean {
  if (hasControlChar(name)) return true;
  for (const ch of name) {
    if (NAME_SEPARATORS.has(ch)) return true;
  }
  return false;
}

/** True if a cookie attribute value contains illegal chars (control or ';'). */
function isInvalidCookieAttr(value: string): boolean {
  return hasControlChar(value) || value.includes(";");
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!name || isInvalidCookieName(name)) {
    throw new CelsianError(`Invalid cookie name: ${JSON.stringify(name)} (contains illegal characters)`);
  }
  if (options.domain && isInvalidCookieAttr(options.domain)) {
    throw new CelsianError(`Invalid cookie domain: ${JSON.stringify(options.domain)} (contains illegal characters)`);
  }
  if (options.path && isInvalidCookieAttr(options.path)) {
    throw new CelsianError(`Invalid cookie path: ${JSON.stringify(options.path)} (contains illegal characters)`);
  }

  // Secure defaults — user-provided options override via spread
  const opts: CookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    ...options,
  };

  let cookie = `${name}=${encodeURIComponent(value)}`;

  if (opts.domain) cookie += `; Domain=${opts.domain}`;
  if (opts.expires) cookie += `; Expires=${opts.expires.toUTCString()}`;
  if (opts.httpOnly) cookie += "; HttpOnly";
  if (opts.maxAge !== undefined) cookie += `; Max-Age=${opts.maxAge}`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  if (opts.sameSite) {
    cookie += `; SameSite=${opts.sameSite.charAt(0).toUpperCase() + opts.sameSite.slice(1)}`;
  }
  if (opts.secure) cookie += "; Secure";

  return cookie;
}
