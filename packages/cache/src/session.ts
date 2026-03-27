// @celsian/cache — Session middleware

import type { KVStore } from "./store.js";

export interface SessionData {
  [key: string]: unknown;
}

export interface Session {
  /** Session ID */
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
  /** Regenerate the session ID (for security after login) */
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
 *   const session = await sessions.create();
 *   session.set('user', { name: 'Alice' });
 *   await session.save();
 *   return reply
 *     .header('set-cookie', sessions.cookie(session.id))
 *     .json({ ok: true });
 * });
 * ```
 */
export function createSessionManager(options: SessionOptions) {
  const store = options.store;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL;
  const cookieName = options.cookieName ?? "sid";
  const prefix = options.prefix ?? "sess:";
  const generateId = options.generateId ?? defaultGenerateId;

  function makeSession(id: string, data: SessionData): Session {
    const sessionData = { ...data };

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
        await store.delete(prefix + id);
        const newId = generateId();
        const newSession = makeSession(newId, sessionData);
        await newSession.save();
        return newSession;
      },
      async save() {
        await store.set(prefix + id, sessionData, ttlMs);
      },
    };

    return session;
  }

  /**
   * Create a new session.
   */
  async function create(initialData?: SessionData): Promise<Session> {
    const id = generateId();
    const session = makeSession(id, initialData ?? {});
    await session.save();
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
   * Returns existing session or creates a new one.
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

    let cookieStr = `${cookieName}=${sessionId}; Path=${path}; Max-Age=${maxAge}; SameSite=${sameSite}`;
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
 */
function parseCookie(header: string, name: string): string | null {
  const cookies = header.split(";");
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.trim().split("=");
    if (key === name) {
      return rest.join("="); // Handle values with = in them
    }
  }
  return null;
}
