// @celsian/core, Cookie parsing and serialization

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

/**
 * The request a cookie is being set in response to. Supplying it lets
 * {@link serializeCookie} pick a `secure` default that a browser will actually
 * honour, instead of guessing. See {@link resolveSecureDefault}.
 */
export interface CookieSecurityContext {
  /** Absolute request URL, e.g. `request.url`. */
  url?: string | URL;
}

/**
 * Hostnames that cannot be reached from the public internet, so a plain-HTTP
 * origin there is development, never a misconfigured production deployment.
 *
 * Loopback names, RFC 1918 private ranges, RFC 3927 link-local, and `.local`
 * mDNS names are all included. The private ranges matter as much as `localhost`
 * does: testing a dev server from a phone means hitting `http://192.168.x.x`,
 * and that is exactly the case where a `Secure` cookie is set, silently
 * dropped by the browser, and never sent back.
 */
function isNonRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
  if (host.endsWith(".local")) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // RFC 3927 link-local
  return false;
}

/** Hosts already warned about, so the warning is once per host, not per cookie. */
const warnedInsecureHosts = new Set<string>();

/** Reset the warn-once state. Exported for tests, not part of the public contract. */
export function resetCookieSecurityWarnings(): void {
  warnedInsecureHosts.clear();
}

/**
 * Decide whether a cookie set in response to `requestUrl` should carry `Secure`.
 *
 * The rules, and why each exists:
 *
 * - **HTTPS: `true`.** Nothing to weigh up.
 * - **Plain HTTP to a non-routable host: `false`.** `Secure` is not a
 *   hardening measure here, it is a silent failure: the browser accepts the
 *   `Set-Cookie` and then never sends the cookie back, so login writes a
 *   session that never returns and `clearCookie()` logout quietly does nothing,
 *   both behind a 200.
 * - **Plain HTTP to a routable host: `true`, plus a one-time warning.** Almost
 *   always a TLS-terminating proxy that did not forward `x-forwarded-proto`, so
 *   dropping `Secure` would strip protection from a real production session.
 *   The warning names the fix, because the other possibility, a genuinely
 *   plain-HTTP public deployment, is a cookie the browser will discard.
 * - **No request context at all: `true`.** `serializeCookie()` called directly
 *   has nothing to infer from, and a secure-by-default guess is the safe one.
 *
 * This deliberately does NOT consult `NODE_ENV`. Containers routinely run
 * without it set, and inferring "not production" from a missing environment
 * variable is what shipped session cookies with no `Secure` flag in the first
 * place. The request's own protocol is a fact, not an inference.
 */
export function resolveSecureDefault(requestUrl: string | URL | undefined): boolean {
  if (!requestUrl) return true;

  let url: URL;
  try {
    url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  } catch {
    return true;
  }

  if (url.protocol === "https:" || url.protocol === "wss:") return true;
  if (url.protocol !== "http:" && url.protocol !== "ws:") return true;

  if (isNonRoutableHost(url.hostname)) return false;

  if (!warnedInsecureHosts.has(url.host)) {
    warnedInsecureHosts.add(url.host);
    console.warn(
      `[celsian] Setting a Secure cookie over plain HTTP for host "${url.host}". ` +
        "Browsers will accept the Set-Cookie header and then never send the cookie back, " +
        "so sessions written this way silently do not persist. " +
        "If this app sits behind a TLS-terminating proxy, forward the x-forwarded-proto header. " +
        "If it genuinely serves plain HTTP, pass { secure: false } explicitly.",
    );
  }
  return true;
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
      // Malformed percent-escapes (e.g. `%ZZ`) throw URIError, fall back to the
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

export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
  context: CookieSecurityContext = {},
): string {
  if (!name || isInvalidCookieName(name)) {
    throw new CelsianError(`Invalid cookie name: ${JSON.stringify(name)} (contains illegal characters)`);
  }
  if (options.domain && isInvalidCookieAttr(options.domain)) {
    throw new CelsianError(`Invalid cookie domain: ${JSON.stringify(options.domain)} (contains illegal characters)`);
  }
  if (options.path && isInvalidCookieAttr(options.path)) {
    throw new CelsianError(`Invalid cookie path: ${JSON.stringify(options.path)} (contains illegal characters)`);
  }

  // Secure defaults, user-provided options override via spread.
  //
  // `secure` is resolved separately rather than through the spread, for two
  // reasons. It has to consult the request context (see resolveSecureDefault),
  // and `{ secure: undefined }` spread over a default would have overwritten
  // that default with `undefined`, which is not what an absent option means.
  const opts: CookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    ...options,
    secure: options.secure ?? resolveSecureDefault(context.url),
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
