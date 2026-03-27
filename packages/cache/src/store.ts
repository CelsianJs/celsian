// @celsian/cache — KV Store abstraction

/**
 * Universal key-value store interface.
 * Implemented by MemoryStore, RedisStore, etc.
 */
export interface KVStore {
  /** Get a value by key. Returns undefined if not found or expired. */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /** Set a value with optional TTL in milliseconds. */
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;

  /** Delete a key. Returns true if the key existed. */
  delete(key: string): Promise<boolean>;

  /** Check if a key exists and is not expired. */
  has(key: string): Promise<boolean>;

  /** Get all keys matching a pattern (glob-style). */
  keys(pattern?: string): Promise<string[]>;

  /** Clear all keys (optionally matching a prefix). */
  clear(prefix?: string): Promise<void>;

  /** Get remaining TTL in milliseconds. Returns -1 if no TTL, -2 if key doesn't exist. */
  ttl(key: string): Promise<number>;

  /** Get multiple values at once. */
  getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]>;

  /** Set multiple values at once. */
  setMany<T = unknown>(entries: Array<{ key: string; value: T; ttlMs?: number }>): Promise<void>;

  /** Increment a numeric value. Returns the new value. */
  incr(key: string, by?: number): Promise<number>;

  /** Decrement a numeric value. Returns the new value. */
  decr(key: string, by?: number): Promise<number>;
}

// ─── In-Memory Store ───

interface MemoryEntry {
  value: unknown;
  expiresAt: number | null;
}

/**
 * In-memory KV store. Good for development, testing, and single-instance deployments.
 * Not shared across processes/workers.
 */
export class MemoryKVStore implements KVStore {
  private store = new Map<string, MemoryEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { cleanupIntervalMs?: number }) {
    const interval = options?.cleanupIntervalMs ?? 60_000;
    if (interval > 0) {
      this.cleanupInterval = setInterval(() => this.cleanup(), interval);
      // Allow process to exit even if interval is still running
      if (typeof this.cleanupInterval === "object" && "unref" in this.cleanupInterval) {
        this.cleanupInterval.unref();
      }
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async keys(pattern?: string): Promise<string[]> {
    const result: string[] = [];
    const regex = pattern ? this.globToRegex(pattern) : null;

    for (const [key, entry] of this.store) {
      if (this.isExpired(entry)) {
        this.store.delete(key);
        continue;
      }
      if (!regex || regex.test(key)) {
        result.push(key);
      }
    }
    return result;
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (!entry.expiresAt) return -1;
    const remaining = entry.expiresAt - Date.now();
    if (remaining <= 0) {
      this.store.delete(key);
      return -2;
    }
    return remaining;
  }

  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    return Promise.all(keys.map((k) => this.get<T>(k)));
  }

  async setMany<T = unknown>(entries: Array<{ key: string; value: T; ttlMs?: number }>): Promise<void> {
    for (const { key, value, ttlMs } of entries) {
      await this.set(key, value, ttlMs);
    }
  }

  async incr(key: string, by = 1): Promise<number> {
    const current = await this.get<number>(key);
    const newValue = (current ?? 0) + by;
    const entry = this.store.get(key);
    await this.set(key, newValue, entry?.expiresAt ? entry.expiresAt - Date.now() : undefined);
    return newValue;
  }

  async decr(key: string, by = 1): Promise<number> {
    return this.incr(key, -by);
  }

  /** Stop the background cleanup timer */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private isExpired(entry: MemoryEntry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  }
}
