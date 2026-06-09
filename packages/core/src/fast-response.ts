// @celsian/core — Fast response payload (Node write fast-path)
//
// reply.json()/html()/send() and the auto-serializer build a fully valid Web
// `Response`, but they ALSO stash the already-serialized body + plain headers on
// it via a non-enumerable symbol. The Node adapter reads that payload and writes
// the response in a single `res.writeHead() + res.end(body)` — skipping the
// `response.body.getReader()` stream drain (and the extra socket write) that a
// generic Response requires.
//
// This is purely additive: the Response is still spec-correct, so Bun/Deno/CF
// and any user code that inspects `response.body` are unaffected — only the Node
// adapter opts into the fast path.

/** Already-serialized response parts, captured at creation time. */
export interface FastPayload {
  body: string | Uint8Array | null;
  headers: Record<string, string>;
  status: number;
  cookies: string[];
}

/** Symbol key for the fast payload. `Symbol.for` so it survives multiple module copies. */
const FAST = Symbol.for("celsian.fastResponse");

/**
 * Build a Web `Response` and tag it with a fast-write payload for the Node adapter.
 * `headers` must be a fresh plain object owned by the caller (not shared/mutated later).
 */
export function fastResponse(
  body: string | Uint8Array | null,
  status: number,
  headers: Record<string, string>,
  cookies: string[] = [],
): Response {
  let resHeaders: Record<string, string> | Headers;
  if (cookies.length === 0) {
    resHeaders = headers;
  } else {
    const h = new Headers(headers);
    for (const c of cookies) h.append("set-cookie", c);
    resHeaders = h;
  }
  const res = new Response(body, { status, headers: resHeaders });
  Object.defineProperty(res, FAST, {
    value: { body, headers, status, cookies } satisfies FastPayload,
    enumerable: false,
  });
  return res;
}

/** Retrieve the fast-write payload from a Response, or undefined if it has none. */
export function getFastPayload(res: Response): FastPayload | undefined {
  return (res as unknown as Record<symbol, FastPayload | undefined>)[FAST];
}
