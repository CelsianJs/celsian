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
  /**
   * The request's headers. Read lazily, and only when a cookie is actually
   * serialized, so supplying this costs the hot path nothing.
   *
   * This matters because `url` is often built from the address the server BOUND
   * to, not the address the browser typed. On Node, `serve()` composes
   * `http://${host}:${port}`, and `host` is `0.0.0.0` under `NODE_ENV=production`.
   * The `Host` header is the browser-facing name, which is the only thing that
   * decides whether a browser will honour `Secure`.
   */
  headers?: Headers;
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
 *
 * The wildcard bind addresses `0.0.0.0` and `::` are deliberately NOT here.
 * They are not names a browser can ever address, they are what a server passes
 * to `listen()` to accept on every interface, and `serve()` picks exactly those
 * under `NODE_ENV=production`. Counting them as development is how every
 * production Node deployment briefly lost the `Secure` flag on its session
 * cookies: the request URL carried `http://0.0.0.0:3000`, which looked local.
 * A wildcard bind is evidence of a container, so it falls through to the
 * secure-by-default branch.
 */
function isNonRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
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
export function resolveSecureDefault(contextOrUrl: CookieSecurityContext | string | URL | undefined = {}): boolean {
  // A bare URL is accepted as well as a full context: it is the shape callers
  // outside the framework naturally reach for, and it is what this function
  // originally took.
  const context: CookieSecurityContext =
    typeof contextOrUrl === "string" || contextOrUrl instanceof URL ? { url: contextOrUrl } : contextOrUrl;
  const { url: requestUrl, headers } = context;

  // A proxy reporting HTTPS is enough on its own, and it is the common shape:
  // TLS terminates at the edge and the app itself only ever sees plain HTTP.
  // Trusting this header can only ever ADD `Secure`, so a spoofed value cannot
  // downgrade anyone.
  const forwardedProto = headers?.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto === "https" || forwardedProto === "wss") return true;

  let url: URL | undefined;
  if (requestUrl) {
    try {
      url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
    } catch {
      url = undefined;
    }
  }

  if (url && (url.protocol === "https:" || url.protocol === "wss:")) return true;
  if (url && url.protocol !== "http:" && url.protocol !== "ws:") return true;

  // Prefer the `Host` header over the URL's hostname. The URL is frequently
  // built from the bind address (`0.0.0.0` in production), whereas `Host` is
  // the name the browser actually addressed, and it is the browser's view that
  // decides whether `Secure` is honoured.
  //
  // `Host` is client-controlled, so a caller can send `Host: localhost` and get
  // a cookie without `Secure`. That only ever affects the cookie in that
  // caller's own browser, since a browser sets `Host` from the URL it was given
  // and an attacker cannot make a victim's browser lie. There is no cross-user
  // downgrade here.
  const hostHeader = headers?.get("host")?.trim();
  const browserFacingHost = hostHeader || url?.host;
  if (!browserFacingHost) return true;

  const hostname = stripPort(browserFacingHost);
  if (isNonRoutableHost(hostname)) return false;

  if (!warnedInsecureHosts.has(browserFacingHost)) {
    warnedInsecureHosts.add(browserFacingHost);
    console.warn(
      `[celsian] Setting a Secure cookie over plain HTTP for host "${browserFacingHost}". ` +
        "Browsers will accept the Set-Cookie header and then never send the cookie back, " +
        "so sessions written this way silently do not persist. " +
        "If this app sits behind a TLS-terminating proxy, have the proxy send x-forwarded-proto: https. " +
        "If it genuinely serves plain HTTP, pass { secure: false } explicitly.",
    );
  }
  return true;
}

/**
 * Take the hostname out of a `Host`-header-shaped value.
 *
 * Bracketed IPv6 (`[::1]:3000`) has to be handled before the port split,
 * because a bare IPv6 address is full of colons.
 */
function stripPort(hostValue: string): string {
  if (hostValue.startsWith("[")) {
    const end = hostValue.indexOf("]");
    if (end !== -1) return hostValue.slice(1, end);
  }
  const colon = hostValue.lastIndexOf(":");
  if (colon !== -1 && !hostValue.slice(colon + 1).includes(":")) {
    return hostValue.slice(0, colon);
  }
  return hostValue;
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
    secure: options.secure ?? resolveSecureDefault(context),
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
