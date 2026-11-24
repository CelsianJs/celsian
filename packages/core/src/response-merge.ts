// @celsian/core -- Carry the reply's headers and cookies onto a finished Response

import { getFastPayload, type Outgoing, peekHeaders, toResponse, WireResponse } from "./fast-response.js";
import { replyCookies } from "./reply.js";
import type { CelsianReply } from "./types.js";

/** A header name `Headers` accepts, already lower-case. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
/**
 * A header value `Headers` accepts and stores unchanged: latin-1 text with no
 * control character but tab, and no whitespace at either end (which `Headers`
 * would strip).
 */
const HEADER_VALUE = /^(?:[\x21-\x7e\x80-\xff](?:[\t\x20-\x7e\x80-\xff]*[\x21-\x7e\x80-\xff])?)?$/;

const NO_COOKIES: readonly string[] = Object.freeze([]);

/** True when every name in `headers` is already lower-case, so a plain lookup finds what `Headers.get()` would. */
function hasLowerCaseNames(headers: Record<string, string>): boolean {
  for (const key in headers) {
    if (key !== key.toLowerCase()) return false;
  }
  return true;
}

/** Union of two `Vary` values, keeping the first value's spelling and order. */
function unionVary(current: string, extra: string): string {
  const tokens = current
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const seen = new Set(tokens.map((t) => t.toLowerCase()));
  if (seen.has("*")) return current;
  let result = current;
  for (const raw of extra.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    if (token === "*") return "*";
    if (seen.has(token.toLowerCase())) continue;
    seen.add(token.toLowerCase());
    result = result.trim() === "" ? token : `${result}, ${token}`;
  }
  return result;
}

function setCookiesOf(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
}

/**
 * Put the headers and cookies set on `reply` onto the outgoing response.
 *
 * A header the Response does not carry is added. When both carry one, the
 * Response keeps its own value: whoever set the reply header could not see the
 * Response, so it cannot have meant to replace it. The one exception is an
 * onSend override, which `shown` detects: it is the snapshot of `reply.headers`
 * the onSend chain started from, and a hook that replaced the exact value the
 * Response carries was shown that value and chose to change it. Pass `null`
 * outside onSend.
 *
 * `Vary` is a list, so the two sides' tokens are united. Set-Cookie values are
 * appended, each at most once, never overwritten.
 *
 * Returns `out` itself when there is nothing to add, so the common path
 * allocates nothing. A fast response (`reply.json()` and friends) that does
 * gain headers comes back as a {@link WireResponse}: the same Response with
 * its final headers beside it, which the Node writer still sends in a single
 * write. Anything else is rebuilt as a new Response, as before.
 */
export function mergeReply(out: Outgoing, reply: CelsianReply, shown: Record<string, string> | null): Outgoing {
  if (out instanceof WireResponse) {
    return (
      mergeIntoFast(out, out.source, out.body, out.status, out.headers, out.cookies, reply, shown) ??
      mergeReplyIntoResponse(toResponse(out), reply, shown)
    );
  }
  const fast = getFastPayload(out);
  // Once the Response's headers have been handed out they may differ from the
  // payload's snapshot, so only the Response itself can be trusted.
  if (fast !== undefined && !fast.headersExposed) {
    const merged = mergeIntoFast(out, out, fast.body, fast.status, fast.headers, fast.cookies, reply, shown);
    if (merged !== null) return merged;
  }
  return mergeReplyIntoResponse(out, reply, shown);
}

/**
 * {@link mergeReply} for a fast response, done on its plain header record
 * instead of a `Headers` object.
 *
 * Returns `null` whenever the plain record cannot be trusted to give the
 * answer `Headers` would: a name that is not lower-case, a name or value
 * `Headers` would reject or rewrite. The caller then merges through `Headers`
 * exactly as it always has, so those cases behave (and fail) as before.
 */
function mergeIntoFast(
  unchanged: Outgoing,
  source: Response,
  body: string | Uint8Array | null,
  status: number,
  baseHeaders: Record<string, string>,
  baseCookies: readonly string[],
  reply: CelsianReply,
  shown: Record<string, string> | null,
): Outgoing | null {
  const replyHeaders = reply.headers;
  let headers: Record<string, string> | null = null;
  let checked = false;

  for (const key in replyHeaders) {
    const value = replyHeaders[key];
    if (typeof value !== "string") continue;
    const name = key.toLowerCase();
    if (name === "set-cookie") continue;
    if (!checked) {
      if (!hasLowerCaseNames(baseHeaders)) return null;
      checked = true;
    }
    const current: unknown = (headers ?? baseHeaders)[name];
    if (current === value) continue;
    let next: string;
    if (current === undefined) {
      next = value;
    } else {
      // A name that resolves to something inherited (`constructor`), or a
      // value `Headers` would have trimmed, compares differently there.
      if (typeof current !== "string" || !HEADER_VALUE.test(current)) return null;
      if (name === "vary") {
        next = unionVary(current, value);
        if (next === current) continue;
      } else if (shown !== null && shown[key] === current) {
        next = value;
      } else {
        continue;
      }
    }
    if (name === "__proto__" || !HEADER_NAME.test(name) || !HEADER_VALUE.test(next)) return null;
    headers ??= { ...baseHeaders };
    headers[name] = next;
  }

  let cookies: string[] | null = null;
  const headerCookie = replyHeaders["set-cookie"];
  const queued = replyCookies(reply);
  if (typeof headerCookie === "string" || queued.length > 0) {
    if (!checked && !hasLowerCaseNames(baseHeaders)) return null;
    // Every Set-Cookie value the response carries so far. A Response is asked
    // directly: its payload shares the reply's cookie list, which may have
    // grown since the Response was built.
    let present: readonly string[];
    if (unchanged === source) {
      present = setCookiesOf(peekHeaders(source));
    } else {
      const carried: unknown = (headers ?? baseHeaders)["set-cookie"];
      if (carried === undefined) present = baseCookies;
      else if (typeof carried === "string" && HEADER_VALUE.test(carried)) present = [carried, ...baseCookies];
      else return null;
    }
    const pending = typeof headerCookie === "string" ? [headerCookie, ...queued] : queued;
    for (const cookie of pending) {
      if ((cookies ?? present).includes(cookie)) continue;
      if (!HEADER_VALUE.test(cookie)) return null;
      cookies ??= [...present];
      cookies.push(cookie);
    }
    // `cookies` now lists every Set-Cookie value, so the header record gives up its own.
    if (cookies !== null && (headers ?? baseHeaders)["set-cookie"] !== undefined) {
      headers ??= { ...baseHeaders };
      delete headers["set-cookie"];
    }
  }

  if (headers === null && cookies === null) return unchanged;
  // The cookie list is copied: a payload's list is the reply's own, and a
  // cookie queued after this point has not been merged yet.
  return new WireResponse(
    source,
    body,
    status,
    headers ?? baseHeaders,
    cookies ?? (baseCookies.length === 0 ? NO_COOKIES : [...baseCookies]),
  );
}

/**
 * {@link mergeReply} through `Headers`, for a Response that carries no fast
 * payload (one the handler built itself, a stream, a file) or whose headers
 * have been handed out. Returns `response` itself when there is nothing to add.
 */
export function mergeReplyIntoResponse(
  response: Response,
  reply: CelsianReply,
  shown: Record<string, string> | null,
): Response {
  const replyHeaders = reply.headers;
  let merged: Headers | null = null;
  // The Response's own headers are only ever READ below (a change is always
  // made on a copy), so they are peeked at: these lookups must not mark a fast
  // response's headers as handed out and push it off the Node fast write.

  for (const key in replyHeaders) {
    const value = replyHeaders[key];
    if (typeof value !== "string") continue;
    const name = key.toLowerCase();
    if (name === "set-cookie") continue;
    const current = (merged ?? peekHeaders(response)).get(name);
    if (current === value) continue;
    if (current === null) {
      merged ??= new Headers(peekHeaders(response));
      merged.set(name, value);
    } else if (name === "vary") {
      const union = unionVary(current, value);
      if (union !== current) {
        merged ??= new Headers(peekHeaders(response));
        merged.set(name, union);
      }
    } else if (shown !== null && shown[key] === current) {
      merged ??= new Headers(peekHeaders(response));
      merged.set(name, value);
    }
  }

  const headerCookie = replyHeaders["set-cookie"];
  const cookies = replyCookies(reply);
  if (typeof headerCookie === "string" || cookies.length > 0) {
    const present = setCookiesOf(merged ?? peekHeaders(response));
    const pending = typeof headerCookie === "string" ? [headerCookie, ...cookies] : cookies;
    for (const cookie of pending) {
      if (present.includes(cookie)) continue;
      present.push(cookie);
      merged ??= new Headers(peekHeaders(response));
      merged.append("set-cookie", cookie);
    }
  }

  if (merged === null) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
