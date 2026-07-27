// @celsian/cache, Session middleware

import type { KVStore } from "./store.js";

/**
 * Structured error for the cache package.
 *
 * `@celsian/cache` has no runtime dependencies (not even `@celsian/core`), so
 * we define a local named error rather than throwing a bare `Error`, matching
 * the framework convention of structured errors.
 */
export class CacheError extends Error {
  override readonly name = "CacheError";
  readonly code = "CACHE_ERROR";
}

/**
 * RFC 6265 cookie-octet set: %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E.
 * Excludes whitespace, control chars, `"`, `,`, `;`, and `\`, i.e. exactly
 * the characters that could break out of the value into cookie attributes
 * (e.g. injecting `; HttpOnly` or CRLF). A value matching this is safe to emit
 * verbatim; anything else is percent-encoded as a defensive fallback so a
 * custom `generateId` can never inject cookie attributes.
 */
const COOKIE_VALUE_SAFE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** Ensure a session id is safe to place in a Set-Cookie value. */
function encodeCookieValue(sessionId: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new CacheError("[@celsian/cache] session id must be a non-empty string");
  }
  if (COOKIE_VALUE_SAFE.test(sessionId)) return sessionId;
  // Percent-encode unsafe values so structural characters (`;`, CR, LF, etc.)
  // cannot inject cookie attributes. encodeURIComponent neutralizes all of them.
  return encodeURIComponent(sessionId);
}

export interface SessionData {
  [key: string]: unknown;
}

export interface Session {
  /**
   * Session ID.
   *
   * Rotates in place when {@link Session.regenerate} is called, so reading it
   * after a privilege change always yields the NEW id.
   */
  readonly id: string;
  /** Get a session value */
  get<T = unknown>(key: string): T | undefined;
  /** Set a session value */
  set(key: string, value: unknown): void;
  /** Delete a session value */
  delete(key: string): void;
  /** Get all session data */
  all(): SessionData;
  /** Destroy the session (clear all data and remove from store) */
  destroy(): Promise<void>;
  /**
   * Rotate the session id, keeping the data. Call this at every privilege
   * boundary (login, role change, step-up auth).
   *
   * Rotation happens IN PLACE: `session.id` becomes the new id, the old store
   * entry is deleted, and a later `save()` on this same object writes the new
   * id. The session is also returned so `const s = await session.regenerate()`
   * keeps reading naturally.
   *
   * Without this call an attacker who plants a session cookie in a victim's
   * browser keeps a valid handle on the session the victim then logs into
   * (session fixation). See the `/login` example on
   * {@link createSessionManager}.
   */
  regenerate(): Promise<Session>;
  /** Save the session to the store */
  save(): Promise<void>;
}

export interface SessionOptions {
  /** KV store for session data */
  store: KVStore;
  /** Session TTL in milliseconds (default: 24 hours) */
  ttlMs?: number;
  /** Cookie name (default: 'sid') */
  cookieName?: string;
  /** Key prefix in the store (default: 'sess:') */
  prefix?: string;
  /** Generate a session ID */
  generateId?: () => string;
}

const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Generate a cryptographically random session ID.
 */
function defaultGenerateId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a session manager.
 *
 * Usage:
 * ```ts
 * const sessions = createSessionManager({
 *   store: new MemoryKVStore(),
 * });
 *
 * app.get('/profile', async (req, reply) => {
 *   const session = await sessions.load(req);
 *   const user = session.get('user');
 *   if (!user) return reply.status(401).json({ error: 'Not logged in' });
 *   return reply.json({ user });
 * });
 *
 * app.post('/login', async (req, reply) => {
 *   const session = await sessions.fromRequest(req);
 *   // ALWAYS rotate the id at a privilege boundary. Without this, a session id
 *   // an attacker planted in the victim's browser stays valid after the victim
 *   // logs in, and the attacker reads the logged-in session (session fixation).
 *   await session.regenerate();
 *   session.set('user', { name: 'Alice' });
 *   await session.save();
 *   return reply
 *     .header('set-cookie', sessions.cookie(session.id))
 *     .json({ ok: true });
 * });
 *
 * app.post('/logout', async (req, reply) => {
 *   const session = await sessions.fromRequest(req);
 *   await session.destroy();
 *   return reply.header('set-cookie', sessions.cookie(session.id, { maxAge: 0 })).json({ ok: true });
 * });
 * ```
 */
export function createSessionManager(options: SessionOptions) {
  const store = options.store;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL;
  const cookieName = options.cookieName ?? "sid";
  const prefix = options.prefix ?? "sess:";
  const generateId = options.generateId ?? defaultGenerateId;

  function makeSession(initialId: string, data: SessionData): Session {
    const sessionData = { ...data };
    // MUTABLE so `regenerate()` can rotate the id in place. When regenerate
    // returned a separate object, `await session.regenerate()` (the natural
    // call, ignoring the return value) left the caller holding, and setting a
    // cookie for, the OLD id, so the session-fixation fix silently did nothing.
    let id = initialId;

    const session: Session = {
      get id() {
        return id;
      },
      get<T = unknown>(key: string): T | undefined {
        return sessionData[key] as T | undefined;
      },
      set(key: string, value: unknown) {
        sessionData[key] = value;
      },
      delete(key: string) {
        delete sessionData[key];
      },
      all() {
        return { ...sessionData };
      },
      async destroy() {
        await store.delete(prefix + id);
        for (const key of Object.keys(sessionData)) {
          delete sessionData[key];
        }
      },
      async regenerate(): Promise<Session> {
        const previousId = id;
        const newId = generateId();
        if (newId === previousId) return session;
        // Rotate in place, then persist under the new id BEFORE dropping the
        // old entry so a concurrent read never sees the session missing.
        id = newId;
        await session.save();
        await store.delete(prefix + previousId);
        return session;
      },
      async save() {
        // An EMPTY session is not persisted. Writing one per cookie-less
        // request gave every crawler hit a 24h entry, so ~10k anonymous
        // requests LRU-evicted every real logged-in session. An empty session
        // also carries nothing worth restoring, so a save that empties it
        // removes the entry rather than storing `{}`.
        if (Object.keys(sessionData).length === 0) {
          await store.delete(prefix + id);
          return;
        }
        await store.set(prefix + id, sessionData, ttlMs);
      },
    };

    return session;
  }

  /**
   * Create a new session.
   *
   * The session is persisted only once it holds data, call `save()` after
   * putting something in it. Creating an empty session writes nothing, so a
   * crawler hitting cookie-less routes cannot fill (and LRU-evict) the store.
   */
  async function create(initialData?: SessionData): Promise<Session> {
    const id = generateId();
    const session = makeSession(id, initialData ?? {});
    if (initialData && Object.keys(initialData).length > 0) {
      await session.save();
    }
    return session;
  }

  /**
   * Load an existing session by ID. Returns undefined if not found.
   */
  async function load(sessionId: string): Promise<Session | undefined> {
    const data = await store.get<SessionData>(prefix + sessionId);
    if (!data) return undefined;
    return makeSession(sessionId, data);
  }

  /**
   * Load session from a request (reads cookie header).
   * Returns the existing session, or a NEW one with a server-generated id.
   *
   * An id from the cookie is only ever used when it already names a stored
   * session. An unrecognized id is never adopted, so a client cannot choose its
   * own session id: `?sid=` links and planted cookies for ids the server never
   * issued get a fresh server-generated id instead.
   *
   * That alone does NOT stop session fixation, because an attacker can obtain a
   * real id from the server and plant that. Call {@link Session.regenerate} at
   * every privilege boundary.
   */
  async function fromRequest(request: Request): Promise<Session> {
    const cookieHeader = request.headers.get("cookie") ?? "";
    const sid = parseCookie(cookieHeader, cookieName);

    if (sid) {
      const existing = await load(sid);
      if (existing) return existing;
    }

    return create();
  }

  /**
   * Generate a Set-Cookie header value for a session.
   */
  function cookie(
    sessionId: string,
    opts?: {
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: "Strict" | "Lax" | "None";
      path?: string;
      maxAge?: number;
    },
  ): string {
    const httpOnly = opts?.httpOnly !== false;
    const secure = opts?.secure !== false; // Default to true for security
    const sameSite = opts?.sameSite ?? "Lax";
    const path = opts?.path ?? "/";
    const maxAge = opts?.maxAge ?? Math.floor(ttlMs / 1000);

    const safeValue = encodeCookieValue(sessionId);
    let cookieStr = `${cookieName}=${safeValue}; Path=${path}; Max-Age=${maxAge}; SameSite=${sameSite}`;
    if (httpOnly) cookieStr += "; HttpOnly";
    if (secure) cookieStr += "; Secure";
    return cookieStr;
  }

  /**
   * Destroy a session by ID.
   */
  async function destroy(sessionId: string): Promise<void> {
    await store.delete(prefix + sessionId);
  }

  return { create, load, fromRequest, cookie, destroy };
}

/**
 * Parse a cookie header to get a specific cookie value.
 *
 * The value is percent-DECODED to mirror {@link encodeCookieValue}, which
 * percent-encodes ids containing characters outside the RFC 6265 cookie-octet
 * set. Without decoding, a custom `generateId` producing such an id round-tripped
 * to a different string on every request, so `fromRequest` silently minted a
 * fresh empty session each time and the user was never logged in.
 */
function parseCookie(header: string, name: string): string | null {
  const cookies = header.split(";");
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.trim().split("=");
    if (key === name) {
      const raw = rest.join("="); // Handle values with = in them
      try {
        return decodeURIComponent(raw);
      } catch {
        // Malformed percent sequence (e.g. a literal `%` in an id we never
        // encoded). Fall back to the raw value rather than throwing on a
        // client-supplied header.
        return raw;
      }
    }
  }
  return null;
}
