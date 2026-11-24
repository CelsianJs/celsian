// @celsian/core -- Fast response payload (Node write fast-path)
//
// reply.json()/html()/send() and the auto-serializer build a fully valid Web
// `Response`, but they ALSO stash the already-serialized body + plain headers on
// it via a non-enumerable symbol. The Node adapter reads that payload and writes
// the response in a single `res.writeHead() + res.end(body)` -- skipping the
// `response.body.getReader()` stream drain (and the extra socket write) that a
// generic Response requires.
//
// This is purely additive: the Response is still spec-correct, so Bun/Deno/CF
// and any user code that inspects `response.body` are unaffected -- only the Node
// adapter opts into the fast path.

/** Already-serialized response parts, captured at creation time. */
export interface FastPayload {
  body: string | Uint8Array | null;
  headers: Record<string, string>;
  status: number;
  cookies: string[];
  /**
   * True once anything outside core has read the Response's `headers`.
   *
   * `headers` and `cookies` above are a snapshot taken when the Response was
   * built. The Response's own `Headers` object stays mutable, and it is what
   * `inject()` and every non-Node runtime read. So code that added a header
   * afterwards (`const res = reply.json(x); res.headers.set("x-late", "1")`)
   * saw it in tests and on Bun, Deno and Workers, while the Node writer sent
   * the snapshot and silently dropped it.
   *
   * A header cannot be changed without first reading `response.headers`, so
   * the getter below records that read here, and the Node writer takes its
   * headers from the live object whenever this is set. An untouched Response
   * still writes from the snapshot, with no per-request cost.
   */
  headersExposed: boolean;
}

/** Symbol key for the fast payload. `Symbol.for` so it survives multiple module copies. */
const FAST = Symbol.for("celsian.fastResponse");

/** The platform's own `Response.prototype.headers` getter. */
const readHeaders = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get as
  | ((this: Response) => Headers)
  | undefined;

/**
 * A `Response` that knows when its headers have been handed out.
 *
 * A subclass rather than a per-instance property: the getter lives on the
 * prototype, so building a fast response costs nothing extra.
 */
class FastResponse extends Response {}

if (readHeaders) {
  Object.defineProperty(FastResponse.prototype, "headers", {
    configurable: true,
    enumerable: true,
    get(this: Response): Headers {
      const payload = (this as unknown as Record<symbol, FastPayload | undefined>)[FAST];
      if (payload !== undefined) payload.headersExposed = true;
      return readHeaders.call(this);
    },
  });
}

/**
 * Read a Response's headers without recording the read.
 *
 * For core's own READ-ONLY lookups on the request path (merging reply headers,
 * response validation). Anything that might mutate the result must use
 * `response.headers`, or the Node writer will not see the change.
 */
export function peekHeaders(response: Response): Headers {
  return readHeaders ? readHeaders.call(response) : response.headers;
}

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
  const res = new FastResponse(body, { status, headers: resHeaders });
  Object.defineProperty(res, FAST, {
    value: { body, headers, status, cookies, headersExposed: false } satisfies FastPayload,
    enumerable: false,
  });
  return res;
}

/** Retrieve the fast-write payload from a Response, or undefined if it has none. */
export function getFastPayload(res: Response): FastPayload | undefined {
  return (res as unknown as Record<symbol, FastPayload | undefined>)[FAST];
}

/**
 * A fast response together with the headers it will actually be sent with.
 *
 * Headers a hook or a plugin sets on the reply (`cors()`, `security()`, any
 * `onSend`) arrive after the handler has built its Response. Putting them on
 * that Response means building a second one around the first one's body
 * stream, which used to cost the Node writer its single `writeHead()+end()`:
 * the copy carried no payload, so the body was drained from a stream instead.
 *
 * Inside core the merged headers are therefore kept beside the Response as
 * plain data. The Node writer sends the already-serialized body with them
 * directly; everything else gets a real Response from {@link toResponse}. The
 * source Response is never modified, so one that a handler holds on to (or
 * returns again for a later request) is not affected by this request's hooks.
 */
export class WireResponse {
  constructor(
    /** The Response these headers were merged onto. Read for its body stream, never written. */
    readonly source: Response,
    readonly body: string | Uint8Array | null,
    readonly status: number,
    /** Every header to send except Set-Cookie values queued by `reply.cookie()`. Lower-case names. */
    readonly headers: Record<string, string>,
    readonly cookies: readonly string[],
  ) {}
}

/** What the request lifecycle hands to a writer: a Response, or a fast response with its final headers. */
export type Outgoing = Response | WireResponse;

/** The headers of a {@link WireResponse} in a form `new Response()` accepts, Set-Cookie values included. */
export function wireHeaders(wire: WireResponse): Record<string, string> | Headers {
  if (wire.cookies.length === 0) return wire.headers;
  const headers = new Headers(wire.headers);
  for (const cookie of wire.cookies) headers.append("set-cookie", cookie);
  return headers;
}

/**
 * The Response a caller outside core receives for `out`.
 *
 * A {@link WireResponse} becomes a new Response over the source's body, as a
 * merge always produced, and keeps the fast payload so a Node writer that is
 * handed it (`@celsian/adapter-node`) still writes it in one go.
 */
export function toResponse(out: Outgoing): Response {
  if (!(out instanceof WireResponse)) return out;
  const source = out.source;
  const res = new FastResponse(source.body, {
    status: source.status,
    statusText: source.statusText,
    headers: wireHeaders(out),
  });
  Object.defineProperty(res, FAST, {
    value: {
      body: out.body,
      headers: out.headers,
      status: out.status,
      cookies: out.cookies as string[],
      headersExposed: false,
    } satisfies FastPayload,
    enumerable: false,
  });
  return res;
}
