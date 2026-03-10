// @celsian/server — WebSocket support
// Works with Bun.serve() and Deno.serve() WebSocket upgrades.
// For Node.js, the adapter handles the upgrade via the 'ws' package.

import type { PluginFunction, RouteHandler } from './types.js';
import { fp } from './types.js';

export interface WSMessage {
  /** Raw message data */
  data: string | ArrayBuffer;
  /** Parsed JSON data (if the message is valid JSON string) */
  json?: unknown;
}

export interface WSHandler {
  /** Called when a client connects */
  open?: (ws: WSSocket) => void;
  /** Called when a message is received */
  message?: (ws: WSSocket, message: WSMessage) => void;
  /** Called when the connection closes */
  close?: (ws: WSSocket, code: number, reason: string) => void;
  /** Called on error */
  error?: (ws: WSSocket, error: Error) => void;
  /** Called for ping messages */
  ping?: (ws: WSSocket) => void;
  /** Called for pong messages */
  pong?: (ws: WSSocket) => void;
}

export interface WSSocket {
  /** Send a text message */
  send(data: string | ArrayBuffer): void;
  /** Send a JSON-serializable object */
  sendJSON(data: unknown): void;
  /** Close the connection */
  close(code?: number, reason?: string): void;
  /** Whether the socket is still open */
  readonly readyState: number;
  /** Arbitrary user data attached to this socket */
  data: Record<string, unknown>;
}

export interface WSRoom {
  /** Add a socket to this room */
  join(ws: WSSocket): void;
  /** Remove a socket from this room */
  leave(ws: WSSocket): void;
  /** Broadcast to all sockets in the room */
  broadcast(data: string | ArrayBuffer): void;
  /** Broadcast JSON to all sockets in the room */
  broadcastJSON(data: unknown): void;
  /** Number of sockets in the room */
  readonly size: number;
  /** Close all connections in the room */
  closeAll(code?: number, reason?: string): void;
}

/**
 * Create a room for grouping WebSocket connections.
 */
export function createRoom(): WSRoom {
  const members = new Set<WSSocket>();

  return {
    join(ws: WSSocket) {
      members.add(ws);
    },
    leave(ws: WSSocket) {
      members.delete(ws);
    },
    broadcast(data: string | ArrayBuffer) {
      for (const ws of members) {
        if (ws.readyState === 1) { // OPEN
          ws.send(data);
        }
      }
    },
    broadcastJSON(data: unknown) {
      const json = JSON.stringify(data);
      for (const ws of members) {
        if (ws.readyState === 1) {
          ws.send(json);
        }
      }
    },
    get size() {
      return members.size;
    },
    closeAll(code?: number, reason?: string) {
      for (const ws of members) {
        ws.close(code, reason);
      }
      members.clear();
    },
  };
}

export interface WSRoute {
  /** URL pattern to match */
  path: string;
  /** WebSocket handlers */
  handler: WSHandler;
}

/**
 * WebSocket route registry — stores WS handlers for upgrade matching.
 *
 * The actual upgrade is runtime-specific:
 * - Bun: `server.upgrade(request)` in the fetch handler
 * - Deno: `Deno.upgradeWebSocket(request)` in the fetch handler
 * - Node: via 'ws' package in the adapter
 *
 * This registry stores the handler definitions so adapters can look them up.
 */
export class WSRegistry {
  private routes: WSRoute[] = [];

  /** Register a WebSocket handler for a path */
  route(path: string, handler: WSHandler): void {
    this.routes.push({ path, handler });
  }

  /** Find the handler for a given pathname */
  match(pathname: string): WSHandler | null {
    for (const route of this.routes) {
      if (route.path === pathname) {
        return route.handler;
      }
    }
    return null;
  }

  /** Get all registered WS routes */
  getRoutes(): WSRoute[] {
    return [...this.routes];
  }
}

/**
 * Wrap a raw WebSocket (from Bun/Deno/Node) into our WSSocket interface.
 */
export function wrapWebSocket(rawWs: {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}): WSSocket {
  const userData: Record<string, unknown> = {};

  return {
    send(data: string | ArrayBuffer) {
      rawWs.send(data);
    },
    sendJSON(data: unknown) {
      rawWs.send(JSON.stringify(data));
    },
    close(code?: number, reason?: string) {
      rawWs.close(code, reason);
    },
    get readyState() {
      return rawWs.readyState;
    },
    data: userData,
  };
}

/**
 * Parse a WebSocket message into our WSMessage format.
 */
export function parseWSMessage(data: string | ArrayBuffer | Uint8Array): WSMessage {
  const msg: WSMessage = { data: data instanceof Uint8Array ? data.buffer as ArrayBuffer : data as string | ArrayBuffer };

  if (typeof data === 'string') {
    try {
      msg.json = JSON.parse(data);
    } catch {
      // Not JSON — leave json as undefined
    }
  }

  return msg;
}

/**
 * WebSocket plugin for CelsianApp.
 * Registers the WS registry on the app and provides a `ws()` method.
 *
 * Usage:
 * ```ts
 * const app = createApp();
 * const registry = new WSRegistry();
 *
 * registry.route('/ws/chat', {
 *   open(ws) { console.log('connected'); },
 *   message(ws, msg) { ws.send(`echo: ${msg.data}`); },
 *   close(ws) { console.log('disconnected'); },
 * });
 *
 * // In Bun adapter:
 * Bun.serve({
 *   fetch(request, server) {
 *     const url = new URL(request.url);
 *     const wsHandler = registry.match(url.pathname);
 *     if (wsHandler && request.headers.get('upgrade') === 'websocket') {
 *       server.upgrade(request, { data: { handler: wsHandler } });
 *       return;
 *     }
 *     return app.handle(request);
 *   },
 *   websocket: {
 *     open(ws) { ws.data.handler.open?.(wrapWebSocket(ws)); },
 *     message(ws, msg) { ws.data.handler.message?.(wrapWebSocket(ws), parseWSMessage(msg)); },
 *     close(ws, code, reason) { ws.data.handler.close?.(wrapWebSocket(ws), code, reason); },
 *   },
 * });
 * ```
 */
export const websocket: PluginFunction = fp(async (app, options) => {
  const registry = (options as { registry?: WSRegistry }).registry ?? new WSRegistry();
  app.decorate('wsRegistry', registry);
});
