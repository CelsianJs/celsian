// @celsian/core -- Request builder

import { parseCookies } from "./cookie.js";
import type { CelsianRequest, ClientIpOptions } from "./types.js";

// Shared empty query object for requests with no query string
const EMPTY_QUERY: Record<string, string | string[]> = Object.freeze(Object.create(null));

// Keys that must never be set via user input (prototype pollution prevention)
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Symbol holding the source Web Request on the wrapper (excluded from Object.keys/JSON).
const SRC = Symbol("celsian.srcRequest");

// Symbol holding the request's resolved `signal`, once something has read it.
const SIGNAL = Symbol("celsian.signal");

// Symbol holding the request's parsed cookies, once something has read them.
const COOKIES = Symbol("celsian.cookies");

// Symbol holding the request timeout's state: undefined when no timeout can
// abort this request, ARMED while one can, the AbortController it will abort
// once `signal` has been read, or a TimedOut record after it fired unobserved.
const TIMEOUT = Symbol("celsian.requestTimeout");
const ARMED = Symbol("celsian.requestTimeout.armed");

/** A request timeout that fired before anything had read the request's `signal`. */
class TimedOut {
  constructor(
    readonly reason: unknown,
    /** The transport had already aborted, so that abort is the one `signal` reports. */
    readonly transportAbortedFirst: boolean,
  ) {}
}

// Symbol recording that the request's body was read straight from the Node
// stream under it: true until the web stream wrapped around that same stream
// has been told, false afterwards. See `takeNodeBody`.
const BODY_READ_DIRECTLY = Symbol("celsian.bodyReadDirectly");

/** The fields the fast request wrapper keeps under symbols. */
interface FastRequestState {
  [SRC]: Request;
  [BODY_READ_DIRECTLY]: boolean | undefined;
  [SIGNAL]: AbortSignal | undefined;
  [COOKIES]: Record<string, string> | undefined;
  [TIMEOUT]: typeof ARMED | AbortController | TimedOut | undefined;
}

/**
 * The signal a handler sees: the transport's own, which a request timeout can
 * also abort. Built on first read. Most handlers never read it, and the
 * controller, the combined signal and their listeners cost more than the rest
 * of the request wrapper put together.
 */
function resolveSignal(state: FastRequestState): AbortSignal {
  const incoming = state[SRC].signal;
  const timeout = state[TIMEOUT];
  if (timeout === undefined) return incoming;
  if (timeout instanceof TimedOut) {
    if (timeout.transportAbortedFirst) return incoming;
    const fired = new AbortController();
    fired.abort(timeout.reason);
    return fired.signal;
  }

  // A timeout can still abort this request. Its controller is separate from
  // the transport's, so a timeout never aborts the upstream signal, and the
  // signal keeps following the transport after the handler returns (a
  // streaming response's producer retains it).
  const controller = timeout === ARMED ? new AbortController() : timeout;
  state[TIMEOUT] = controller;
  // The transport is followed with a listener, never with AbortSignal.any().
  // Node keeps a composite signal that has an "abort" listener in a global set
  // (gcPersistentSignals) and only lets go of it when the listener is removed.
  // A handler that leaves a listener on `request.signal` (not `{ once: true }`,
  // never removed) therefore pinned the composite for the life of the process,
  // and with it whatever the listener closes over and, once the signal had
  // aborted, the sources and everything the abort reason's stack reaches: the
  // IncomingMessage, its socket and its ServerResponse, for every request a
  // client abandoned. A controller's own signal is in no such set. Everything
  // here is request-local, so it is collected with the request.
  const abort = () => controller.abort(incoming.reason);
  if (incoming.aborted) abort();
  else {
    incoming.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", () => incoming.removeEventListener("abort", abort), { once: true });
  }
  return controller.signal;
}

/** Note that a request timeout may abort `request` from now on. Fast requests only. */
export function armRequestTimeout(request: CelsianRequest): void {
  const state = request as unknown as FastRequestState;
  if (state[TIMEOUT] === undefined) state[TIMEOUT] = ARMED;
}

/** The request timeout fired: abort `request.signal` with `reason`, now or when it is first read. */
export function fireRequestTimeout(request: CelsianRequest, reason: unknown): void {
  const state = request as unknown as FastRequestState;
  const timeout = state[TIMEOUT];
  if (timeout instanceof AbortController) timeout.abort(reason);
  else if (timeout === ARMED) state[TIMEOUT] = new TimedOut(reason, state[SRC].signal.aborted);
}

/** The request finished before its timeout: the timeout can no longer abort `request.signal`. */
export function disarmRequestTimeout(request: CelsianRequest): void {
  const state = request as unknown as FastRequestState;
  // A controller that was handed out stays where it is; it is simply never aborted.
  if (state[TIMEOUT] === ARMED) state[TIMEOUT] = undefined;
}

// ─── Reading a Node request's body without the web stream ───
//
// On core's Node server a request body is a Node stream, which the Request
// wraps in a web ReadableStream (two of them, in fact). Reading a JSON body
// through that wrapping costs some thirty promises in Node's stream plumbing.
// The body parser therefore reads the Node stream itself when it can.
//
// The Request must not notice the difference. Afterwards its own stream is
// still unread, though the bytes under it are gone. So the first time anything
// asks the request about its body (`bodyUsed`, `body`, `text()`, `clone()`...)
// that stream is cancelled, which marks it used. From then on the Request
// answers exactly as it does after a body has been read through it: `bodyUsed`
// is true, `text()` rejects with the platform's own "body already read" error,
// `clone()` throws. A request whose body nobody asks about again never pays
// for the cancel.

/**
 * Where a server records, on the Web Request it built, the Node stream that
 * request's body comes from. `Symbol.for` so separately bundled copies agree.
 */
const NODE_BODY = Symbol.for("celsian.nodeBody");

/** The part of Node's `IncomingMessage` the body parser reads from. */
export interface NodeBodyStream {
  readonly readableEnded: boolean;
  readonly readableDidRead: boolean;
  readonly destroyed: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: the listener type Node's own EventEmitter declares
  on(event: string, listener: (...args: any[]) => void): unknown;
  // biome-ignore lint/suspicious/noExplicitAny: the listener type Node's own EventEmitter declares
  off(event: string, listener: (...args: any[]) => void): unknown;
  pause(): unknown;
}

/** Record that `request`'s body is `stream`, so the body parser can read it without the web stream. */
export function setNodeBody(request: Request, stream: NodeBodyStream): void {
  (request as unknown as Record<symbol, NodeBodyStream | undefined>)[NODE_BODY] = stream;
}

/** Stop offering `request`'s Node stream to the body parser (the request was cloned, say). */
export function clearNodeBody(request: Request): void {
  (request as unknown as Record<symbol, NodeBodyStream | undefined>)[NODE_BODY] = undefined;
}

/**
 * The Node stream to read `request`'s body from, or `undefined` when it must be
 * read through the request as usual.
 *
 * Offered once, and only while nothing else can be reading the same bytes: the
 * request's own stream is neither locked nor read, and nothing has read from
 * the Node stream. Whoever takes it must read it to the end or fail.
 */
export function takeNodeBody(request: CelsianRequest | Request): NodeBodyStream | undefined {
  const state = request as unknown as Partial<FastRequestState>;
  const source = state[SRC];
  // Only the fast wrapper has a source Request to ask.
  if (source === undefined || state[BODY_READ_DIRECTLY] !== undefined) return undefined;
  const stream = (source as unknown as Record<symbol, NodeBodyStream | undefined>)[NODE_BODY];
  if (stream === undefined || stream.readableDidRead) return undefined;
  const body = source.body;
  if (body === null || body.locked || source.bodyUsed) return undefined;
  state[BODY_READ_DIRECTLY] = true;
  return stream;
}

/**
 * Bring the source Request up to date before it is asked about its body: if
 * the body was read from the Node stream, mark the Request's own stream used.
 */
function settleBody(state: FastRequestState): Request {
  const source = state[SRC];
  if (state[BODY_READ_DIRECTLY] === true) {
    state[BODY_READ_DIRECTLY] = false;
    // Cancelling is how a stream is marked used without being read. The Node
    // stream under it has ended, so there is nothing left for it to release.
    void source.body?.cancel().catch(() => {});
  }
  return source;
}

// Shared prototype for fast request wrappers: body-consuming methods and the
// live body/bodyUsed accessors delegate to the source Request via `this[SRC]`.
// Using a prototype avoids per-request `.bind()` (×6) and `Object.defineProperty`
// (×2) -- ~10× cheaper to construct than per-request property definition.
const REQUEST_PROTO = {
  get signal(): AbortSignal {
    const state = this as unknown as FastRequestState;
    let signal = state[SIGNAL];
    if (signal === undefined) {
      signal = resolveSignal(state);
      state[SIGNAL] = signal;
    }
    return signal;
  },
  set signal(value: AbortSignal) {
    (this as unknown as FastRequestState)[SIGNAL] = value;
  },
  // Parsed from the Cookie header the first time they are read. This used to
  // be a getter defined on every request with Object.defineProperty, which
  // cost more than building the rest of the wrapper.
  get cookies(): Record<string, string> {
    const state = this as unknown as FastRequestState;
    let cookies = state[COOKIES];
    if (cookies === undefined) {
      cookies = parseCookies(state[SRC].headers.get("cookie") ?? "");
      state[COOKIES] = cookies;
    }
    return cookies;
  },
  get body() {
    return settleBody(this as unknown as FastRequestState).body;
  },
  get bodyUsed() {
    return settleBody(this as unknown as FastRequestState).bodyUsed;
  },
  json() {
    return settleBody(this as unknown as FastRequestState).json();
  },
  text() {
    return settleBody(this as unknown as FastRequestState).text();
  },
  formData() {
    return settleBody(this as unknown as FastRequestState).formData();
  },
  arrayBuffer() {
    return settleBody(this as unknown as FastRequestState).arrayBuffer();
  },
  blob() {
    return settleBody(this as unknown as FastRequestState).blob();
  },
  clone() {
    return settleBody(this as unknown as FastRequestState).clone();
  },
};

/**
 * A syntactically safe authority: `host[:port]`, or a bracketed IPv6 literal.
 *
 * `Host` and `x-forwarded-host` are attacker-controlled strings. Splicing one
 * into a URL unchecked lets `Host: evil.com@real.com` (userinfo), `Host: a/b`
 * (path) or a `Host` with a stray `?`/`#` re-point the parsed URL, or produce a
 * string that throws on the next `new URL()`. Anything not matching is ignored
 * and the transport-level authority is kept.
 */
const SAFE_AUTHORITY = /^(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?$/;

/** A URL scheme token, per RFC 3986: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`. */
const SAFE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;

/** Options controlling how far `x-forwarded-*` is trusted. See `CelsianAppOptions`. */
export interface ForwardedTrustOptions {
  trustProxy?: boolean;
  trustedHosts?: string[];
  clientIp?: ClientIpOptions;
}

/**
 * Where an adapter records the connection's peer address on a Web Request.
 * `Symbol.for` so an adapter and an app bundled with separate copies of this
 * module still agree on it.
 */
const REMOTE_ADDRESS = Symbol.for("celsian.remoteAddress");

/**
 * Record the address of the peer that opened the connection on `request`, so
 * the app reports it as `request.ip`. Adapters call this with what their runtime
 * reports: Node's `socket.remoteAddress`, Bun's `server.requestIP()`, Deno's
 * `info.remoteAddr`. A missing or empty address is ignored. Returns `request`.
 */
export function setRemoteAddress(request: Request, address: string | null | undefined): Request {
  if (typeof address === "string" && address !== "") {
    (request as unknown as Record<symbol, string>)[REMOTE_ADDRESS] = address;
  }
  return request;
}

/**
 * The peer address a runtime passes a fetch handler as its second argument:
 * Bun's `server.requestIP(request)` or Deno's `info.remoteAddr.hostname`.
 * Anything else, Cloudflare's bindings object for one, yields `undefined`.
 */
export function remoteAddressFromServeContext(request: Request, context: unknown): string | undefined {
  if (context === null || typeof context !== "object") return undefined;
  const requestIP = (context as { requestIP?: unknown }).requestIP;
  if (typeof requestIP === "function") {
    try {
      const info = requestIP.call(context, request) as { address?: unknown } | null | undefined;
      return typeof info?.address === "string" ? info.address : undefined;
    } catch {
      return undefined;
    }
  }
  const remoteAddr = (context as { remoteAddr?: unknown }).remoteAddr;
  if (remoteAddr !== null && typeof remoteAddr === "object") {
    const hostname = (remoteAddr as { hostname?: unknown }).hostname;
    return typeof hostname === "string" ? hostname : undefined;
  }
  return undefined;
}

/** Longest textual IP address: an IPv6 address with an embedded IPv4 tail. */
const MAX_IP_LENGTH = 45;
const IP_CHARS = /^[0-9A-Fa-f:.]+$/;

/**
 * True for text that can be an IPv4 or IPv6 address. Deliberately loose (it
 * does not validate octets): it exists to keep arbitrary header text, which the
 * client may have written, out of `request.ip`.
 */
function looksLikeIp(value: string): boolean {
  return value.length <= MAX_IP_LENGTH && IP_CHARS.test(value) && (value.includes(".") || value.includes(":"));
}

/**
 * The client address Celsian reports as `request.ip` for `request`.
 *
 * Without `clientIp` this is the peer address an adapter recorded with
 * {@link setRemoteAddress}, and no header is read. With it, the named header's
 * entry `hops` from the right is used when present and address-shaped, and the
 * peer address otherwise. `undefined` when neither is available.
 */
export function resolveClientIp(request: Request, clientIp?: ClientIpOptions): string | undefined {
  const peer = (request as unknown as Record<symbol, string | undefined>)[REMOTE_ADDRESS];
  if (clientIp === undefined) return peer;
  const raw = request.headers.get(clientIp.header);
  if (raw === null) return peer;
  const entries = raw.split(",");
  const entry = entries[entries.length - (clientIp.hops ?? 1)]?.trim();
  return entry !== undefined && looksLikeIp(entry) ? entry : peer;
}

/**
 * The URL the *client* addressed, rebuilt from `rawUrl` plus the request headers.
 *
 * Adapters synthesize `request.url` from the address the server is bound to
 * (`serve()` uses `http://${host}:${port}`), so on a real deployment it reads
 * `http://0.0.0.0:3000/...` no matter what the browser asked for. Every
 * host-sensitive control downstream, the CSRF same-origin check, response-cache
 * keys, absolute redirects, then compares against the bind address instead of
 * the site. This restores the browser's view:
 *
 * - the `Host` header replaces the bind authority (this is what the client sent);
 * - with `trustProxy`, `x-forwarded-proto` sets the scheme;
 * - with `trustProxy`, `x-forwarded-host` replaces the authority *only* when it
 *   appears in the `trustedHosts` allowlist. Un-allowlisted values are ignored,
 *   which is the host-header-injection guard.
 *
 * Deliberately string surgery rather than `new URL()`: this runs on every
 * request, and it returns `rawUrl` itself (same reference, no allocation) in the
 * common case where nothing overrides the transport authority.
 *
 * @param rawUrl The adapter's URL. Relative URLs are returned untouched.
 * @param authorityStart Index of the first authority character (after `://`), or -1.
 * @param authorityEnd Index one past the last authority character.
 */
export function applyForwardedAuthority(
  rawUrl: string,
  authorityStart: number,
  authorityEnd: number,
  headers: Headers,
  options: ForwardedTrustOptions,
): string {
  if (authorityStart < 3) return rawUrl;

  const authority = rawUrl.slice(authorityStart, authorityEnd);
  const scheme = rawUrl.slice(0, authorityStart - 3);
  let nextAuthority = authority;
  let nextScheme = scheme;

  const hostHeader = headers.get("host");
  if (hostHeader !== null && SAFE_AUTHORITY.test(hostHeader)) nextAuthority = hostHeader;

  if (options.trustProxy) {
    // A proxy chain appends, so the left-most entry is the original client's.
    const proto = headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
    if (proto && SAFE_SCHEME.test(proto)) nextScheme = proto;

    const forwardedHost = headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
    if (forwardedHost && SAFE_AUTHORITY.test(forwardedHost) && options.trustedHosts?.includes(forwardedHost) === true) {
      nextAuthority = forwardedHost;
    }
  }

  if (nextAuthority === authority && nextScheme === scheme) return rawUrl;
  return `${nextScheme}://${nextAuthority}${rawUrl.slice(authorityEnd)}`;
}

/**
 * `applyForwardedAuthority` for callers that hold only the URL string, i.e. the
 * paths (WebSocket upgrade, adapters) that are not the request hot path and so
 * have not already scanned it. Locates the authority, then delegates.
 */
export function resolveEffectiveUrl(rawUrl: string, headers: Headers, options: ForwardedTrustOptions): string {
  const schemeSep = rawUrl.indexOf("://");
  if (schemeSep === -1) return rawUrl;
  const authorityStart = schemeSep + 3;
  let authorityEnd = rawUrl.length;
  for (let i = authorityStart; i < rawUrl.length; i++) {
    const code = rawUrl.charCodeAt(i);
    if (code === 47 /* '/' */ || code === 63 /* '?' */ || code === 35 /* '#' */) {
      authorityEnd = i;
      break;
    }
  }
  return applyForwardedAuthority(rawUrl, authorityStart, authorityEnd, headers, options);
}

/**
 * Build a CelsianRequest from a Web Standard Request, parsed URL, and route params.
 * Body-consuming methods are bound to the original Request to preserve internal slots.
 *
 * `url` is authoritative for `request.url`: callers pass the *effective* URL (see
 * {@link resolveEffectiveUrl}), not the adapter's bind-address URL.
 */
export function buildRequest(request: Request, url: URL, params: Record<string, string>): CelsianRequest {
  // Use frozen empty object when there's no query string to avoid per-request allocation
  let query: Record<string, string | string[]>;
  const searchStr = url.search;
  if (!searchStr || searchStr === "?") {
    query = EMPTY_QUERY as Record<string, string | string[]>;
  } else {
    query = Object.create(null);
    for (const [key, value] of url.searchParams) {
      if (BLOCKED_KEYS.has(key)) continue;
      const existing = query[key];
      if (existing !== undefined) {
        query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        query[key] = value;
      }
    }
  }

  // Direct property assignment -- avoids per-property getter closures.
  // Delegate only body-consuming methods that need the original Request's `this`.
  const celsianRequest = Object.create(null) as CelsianRequest;
  const req = celsianRequest as Record<string, unknown>;
  req.headers = request.headers;
  req.method = request.method;
  req.url = url.href;
  req.signal = request.signal;
  req.params = params;
  req.query = query;
  req.parsedBody = undefined;

  // Bind body-consuming methods (they check internal slots on the original Request)
  req.json = request.json.bind(request);
  req.text = request.text.bind(request);
  req.formData = request.formData.bind(request);
  req.arrayBuffer = request.arrayBuffer.bind(request);
  req.blob = request.blob.bind(request);
  req.clone = request.clone.bind(request);

  // Lazy getters for rarely-accessed properties
  Object.defineProperty(celsianRequest, "body", { get: () => request.body, configurable: true, enumerable: true });
  Object.defineProperty(celsianRequest, "bodyUsed", {
    get: () => request.bodyUsed,
    configurable: true,
    enumerable: true,
  });

  // Copy any custom properties set on the request (e.g., env/ctx from Cloudflare adapter)
  for (const key of Object.keys(request)) {
    if (!(key in celsianRequest)) {
      (celsianRequest as Record<string, unknown>)[key] = (request as unknown as Record<string, unknown>)[key];
    }
  }

  return celsianRequest;
}

/**
 * Fast request builder that accepts pre-parsed pathname and query string,
 * avoiding URL object creation on the hot path.
 *
 * `effectiveUrl` is the URL the client actually addressed, as resolved by
 * `CelsianApp.handle` from the `Host` header (and the trusted `x-forwarded-*`
 * headers). It is what `request.url` reports. Passing the source `Request`'s
 * own `url` here would leak the server's *bind* address instead, because
 * `serve()` builds it as `http://${bindHost}:${port}`, and every same-origin
 * check and cache key downstream would then compare against `0.0.0.0`.
 */
export function buildRequestFast(
  request: Request,
  _pathname: string,
  queryString: string,
  params: Record<string, string>,
  effectiveUrl: string,
): CelsianRequest {
  // Parse query string without creating a URL object
  let query: Record<string, string | string[]>;
  if (!queryString) {
    query = EMPTY_QUERY as Record<string, string | string[]>;
  } else {
    query = Object.create(null);
    // Use URLSearchParams for correct parsing (handles encoding, +, etc.)
    const searchParams = new URLSearchParams(queryString);
    for (const [key, value] of searchParams) {
      if (BLOCKED_KEYS.has(key)) continue;
      const existing = query[key];
      if (existing !== undefined) {
        query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        query[key] = value;
      }
    }
  }

  // Construct from a shared prototype: body/bodyUsed and the body-consuming
  // methods delegate to the source Request via `this[SRC]`. This avoids 6
  // per-request `.bind()` calls and 2 `Object.defineProperty` calls (~10× cheaper).
  const celsianRequest = Object.create(REQUEST_PROTO) as CelsianRequest;
  const req = celsianRequest as unknown as Record<string | symbol, unknown>;
  req[SRC] = request;
  req[BODY_READ_DIRECTLY] = undefined;
  req[SIGNAL] = undefined;
  req[COOKIES] = undefined;
  req[TIMEOUT] = undefined;
  req.headers = request.headers;
  req.method = request.method;
  req.url = effectiveUrl;
  req.params = params;
  req.query = query;
  req.parsedBody = undefined;

  // Copy any custom properties set on the request (e.g., env/ctx from Cloudflare adapter)
  const requestKeys = Object.keys(request);
  if (requestKeys.length > 0) {
    for (const key of requestKeys) {
      if (!(key in celsianRequest)) {
        (celsianRequest as Record<string, unknown>)[key] = (request as unknown as Record<string, unknown>)[key];
      }
    }
  }

  return celsianRequest;
}
