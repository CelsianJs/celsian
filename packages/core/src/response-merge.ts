// @celsian/core -- Carry the reply's headers and cookies onto a finished Response

import { replyCookies } from "./reply.js";
import type { CelsianReply } from "./types.js";

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
 * Put the headers and cookies set on `reply` onto `response`.
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
 * Returns `response` itself when there is nothing to add, so the common path
 * allocates nothing and keeps the Node adapter's fast-write payload.
 */
export function mergeReplyIntoResponse(
  response: Response,
  reply: CelsianReply,
  shown: Record<string, string> | null,
): Response {
  const replyHeaders = reply.headers;
  let merged: Headers | null = null;

  for (const key in replyHeaders) {
    const value = replyHeaders[key];
    if (typeof value !== "string") continue;
    const name = key.toLowerCase();
    if (name === "set-cookie") continue;
    const current = (merged ?? response.headers).get(name);
    if (current === value) continue;
    if (current === null) {
      merged ??= new Headers(response.headers);
      merged.set(name, value);
    } else if (name === "vary") {
      const union = unionVary(current, value);
      if (union !== current) {
        merged ??= new Headers(response.headers);
        merged.set(name, union);
      }
    } else if (shown !== null && shown[key] === current) {
      merged ??= new Headers(response.headers);
      merged.set(name, value);
    }
  }

  const headerCookie = replyHeaders["set-cookie"];
  const cookies = replyCookies(reply);
  if (typeof headerCookie === "string" || cookies.length > 0) {
    const present = setCookiesOf(merged ?? response.headers);
    const pending = typeof headerCookie === "string" ? [headerCookie, ...cookies] : cookies;
    for (const cookie of pending) {
      if (present.includes(cookie)) continue;
      present.push(cookie);
      merged ??= new Headers(response.headers);
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
