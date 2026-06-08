// @celsian/ws-redis -- Distributed WebSocket broadcast via Redis pub/sub

import { CelsianError, type WSConnection, type WSRegistry } from "@celsian/core";
import Redis from "ioredis";

/** Channel prefix used for Redis pub/sub keys */
const CHANNEL_PREFIX = "ws:";

/**
 * Dedicated channel used for cross-node `broadcastAll('*')` fan-out. Every
 * adapter instance subscribes to this on construction so a global broadcast
 * reaches all connections on all nodes — including paths that only exist on
 * remote nodes (which a per-path fan-out would miss).
 */
const FANOUT_CHANNEL = `${CHANNEL_PREFIX}__all__`;

export interface RedisWSAdapterOptions {
  /** Redis connection URL (redis://...) */
  url?: string;
  /** Existing ioredis publisher client */
  publisher?: Redis;
  /** Existing ioredis subscriber client */
  subscriber?: Redis;
  /**
   * Optional callback for connection-level errors emitted by owned ioredis
   * clients. Defaults to logging via console.error. Ignored when external
   * publisher/subscriber clients are supplied (the caller owns error handling
   * for clients they created).
   */
  onError?: (error: Error) => void;
}

/**
 * Message envelope published to Redis.
 * Includes a sender ID so the originating node can skip re-broadcasting.
 */
interface RedisWSMessage {
  /** Unique node ID to prevent echo */
  nodeId: string;
  /** The path this message was broadcast on */
  path: string;
  /** Message data (string only — ArrayBuffer is base64-encoded) */
  data: string;
  /** Whether data is base64-encoded binary */
  binary: boolean;
  /** Connection ID to exclude from broadcast (optional) */
  exclude?: string;
}

/**
 * A distributed WebSocket adapter that wraps a WSRegistry and uses
 * Redis pub/sub to broadcast messages across multiple server instances.
 *
 * When `broadcast()` is called on the adapter, it:
 * 1. Sends to local connections immediately via the underlying registry
 * 2. Publishes the message to a Redis channel so other nodes relay it
 *
 * When a message arrives from Redis:
 * 1. If it originated from this node, it's ignored (already sent locally)
 * 2. Otherwise, it's forwarded to all local connections on the matching path
 */
export class RedisWSAdapter {
  readonly nodeId: string;
  private pub: Redis;
  private sub: Redis;
  private ownsClients: boolean;
  private registry: WSRegistry;
  private subscribedChannels = new Set<string>();
  private closed = false;

  constructor(registry: WSRegistry, options: RedisWSAdapterOptions) {
    this.nodeId = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.registry = registry;

    if (options.publisher && options.subscriber) {
      this.pub = options.publisher;
      this.sub = options.subscriber;
      this.ownsClients = false;
    } else if (options.url) {
      this.pub = new Redis(options.url);
      this.sub = new Redis(options.url);
      this.ownsClients = true;
    } else {
      throw new CelsianError("RedisWSAdapter requires either a url or publisher+subscriber clients");
    }

    // Attach 'error' listeners to BOTH owned clients so a connection failure
    // degrades (logs) instead of emitting an unhandled 'error' event that would
    // crash the process. Skipped for external clients — the caller owns those.
    if (this.ownsClients) {
      const onError =
        options.onError ??
        ((error: Error) => {
          console.error("[celsian:ws-redis] redis client error:", error.message);
        });
      this.pub.on("error", onError);
      this.sub.on("error", onError);
    }

    // Listen for messages from Redis and relay to local connections
    this.sub.on("message", (channel: string, message: string) => {
      this.handleRedisMessage(channel, message);
    });

    // Subscribe to the global fan-out channel so cross-node broadcastAll works
    // regardless of which paths exist locally. Errors are handled by the
    // 'error' listener above; we intentionally don't await here (constructor).
    void this.sub.subscribe(FANOUT_CHANNEL).catch(() => {
      // Subscription failure is surfaced via the 'error' listener; broadcastAll
      // will simply not reach this node until the connection recovers.
    });
    this.subscribedChannels.add(FANOUT_CHANNEL);
  }

  /**
   * Subscribe to a path's Redis channel. Call this when registering
   * a WebSocket handler for a path.
   */
  async subscribePath(path: string): Promise<void> {
    const channel = CHANNEL_PREFIX + path;
    if (this.subscribedChannels.has(channel)) return;
    this.subscribedChannels.add(channel);
    await this.sub.subscribe(channel);
  }

  /**
   * Broadcast a message to all connections on a path, both locally
   * and across all Redis-connected nodes.
   */
  async broadcast(path: string, data: string | ArrayBuffer, exclude?: string): Promise<void> {
    if (this.closed) return;

    // Send to local connections immediately
    this.registry.broadcast(path, data, exclude);

    // Publish to Redis for other nodes
    const channel = CHANNEL_PREFIX + path;
    const msg: RedisWSMessage = {
      nodeId: this.nodeId,
      path,
      data: typeof data === "string" ? data : bufferToBase64(data),
      binary: typeof data !== "string",
      exclude,
    };

    await this.pub.publish(channel, JSON.stringify(msg));
  }

  /**
   * Broadcast a message to all connections across all paths, both locally and
   * across all Redis-connected nodes.
   *
   * Cross-node fan-out goes over a single dedicated channel ({@link FANOUT_CHANNEL})
   * that every adapter subscribes to on construction. Each receiving node then
   * calls `registry.broadcastAll`, so the message reaches every connection on
   * every node — including paths that exist only on remote nodes. (The previous
   * implementation re-published to the originating node's per-path channels,
   * which silently missed paths not subscribed locally.)
   */
  async broadcastAll(data: string | ArrayBuffer, exclude?: string): Promise<void> {
    if (this.closed) return;

    // Send locally
    this.registry.broadcastAll(data, exclude);

    // Publish once to the global fan-out channel for all other nodes.
    const msg: RedisWSMessage = {
      nodeId: this.nodeId,
      path: "*",
      data: typeof data === "string" ? data : bufferToBase64(data),
      binary: typeof data !== "string",
      exclude,
    };

    await this.pub.publish(FANOUT_CHANNEL, JSON.stringify(msg));
  }

  /**
   * Add a connection to the registry. Delegates to the underlying WSRegistry.
   */
  addConnection(path: string, ws: WSConnection): void {
    this.registry.addConnection(path, ws);
  }

  /**
   * Remove a connection from the registry. Delegates to the underlying WSRegistry.
   */
  removeConnection(path: string, ws: WSConnection): void {
    this.registry.removeConnection(path, ws);
  }

  /**
   * Get the total number of local connections.
   */
  getConnectionCount(path?: string): number {
    return this.registry.getConnectionCount(path);
  }

  /**
   * Gracefully close Redis connections and clean up subscriptions.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.subscribedChannels.size > 0) {
      await this.sub.unsubscribe(...this.subscribedChannels);
      this.subscribedChannels.clear();
    }
    if (this.ownsClients) {
      await Promise.all([this.pub.quit(), this.sub.quit()]);
    }
  }

  private handleRedisMessage(channel: string, message: string): void {
    try {
      const parsed: RedisWSMessage = JSON.parse(message);

      // Skip messages from this node (already broadcast locally)
      if (parsed.nodeId === this.nodeId) return;

      const data = parsed.binary ? base64ToBuffer(parsed.data) : parsed.data;

      if (channel === FANOUT_CHANNEL) {
        // Global fan-out from another node — deliver to every local connection.
        this.registry.broadcastAll(data, parsed.exclude);
      } else {
        this.registry.broadcast(parsed.path, data, parsed.exclude);
      }
    } catch {
      // Malformed message — ignore
    }
  }
}

/**
 * Create a Redis-backed WebSocket adapter for distributed broadcasting.
 *
 * @param redisUrl - Redis connection URL (redis://host:port)
 * @returns A function that creates a RedisWSAdapter wrapping a WSRegistry
 *
 * @example
 * ```ts
 * const adapter = createRedisWSAdapter('redis://localhost:6379');
 * const registry = new WSRegistry();
 * const wsRedis = adapter(registry);
 *
 * // Subscribe to a path
 * await wsRedis.subscribePath('/chat');
 *
 * // Broadcast across all nodes
 * await wsRedis.broadcast('/chat', JSON.stringify({ msg: 'hello' }));
 * ```
 */
export function createRedisWSAdapter(redisUrl: string): (registry: WSRegistry) => RedisWSAdapter {
  return (registry: WSRegistry) => new RedisWSAdapter(registry, { url: redisUrl });
}

// ─── Helpers ───

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
