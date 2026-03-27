// @celsian/core — WebSocket support

import type { CelsianRequest } from "./types.js";

export interface WSHandler {
  open?: (ws: WSConnection, req: CelsianRequest) => void;
  message?: (ws: WSConnection, data: string | ArrayBuffer) => void;
  close?: (ws: WSConnection, code: number, reason: string) => void;
}

export interface WSConnection {
  id: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  metadata: Record<string, unknown>;
}

let _wsIdCounter = 0;

function generateWSId(): string {
  _wsIdCounter = (_wsIdCounter + 1) % 0x7fffffff;
  return `ws-${Date.now().toString(36)}-${_wsIdCounter.toString(36)}`;
}

export class WSRegistry {
  private handlers = new Map<string, WSHandler>();
  private connections = new Map<string, Set<WSConnection>>();

  register(path: string, handler: WSHandler): void {
    this.handlers.set(path, handler);
    this.connections.set(path, new Set());
  }

  getHandler(path: string): WSHandler | undefined {
    return this.handlers.get(path);
  }

  hasPath(path: string): boolean {
    return this.handlers.has(path);
  }

  hasAnyHandlers(): boolean {
    return this.handlers.size > 0;
  }

  addConnection(path: string, ws: WSConnection): void {
    const set = this.connections.get(path);
    if (set) set.add(ws);
  }

  removeConnection(path: string, ws: WSConnection): void {
    const set = this.connections.get(path);
    if (set) set.delete(ws);
  }

  broadcast(path: string, data: string | ArrayBuffer, exclude?: string): void {
    const set = this.connections.get(path);
    if (!set) return;
    for (const ws of set) {
      if (exclude && ws.id === exclude) continue;
      try {
        ws.send(data);
      } catch {
        // Connection may have closed
      }
    }
  }

  broadcastAll(data: string | ArrayBuffer, exclude?: string): void {
    for (const [, set] of this.connections) {
      for (const ws of set) {
        if (exclude && ws.id === exclude) continue;
        try {
          ws.send(data);
        } catch {
          // Connection may have closed
        }
      }
    }
  }

  getConnectionCount(path?: string): number {
    if (path) {
      return this.connections.get(path)?.size ?? 0;
    }
    let count = 0;
    for (const [, set] of this.connections) {
      count += set.size;
    }
    return count;
  }
}

export function createWSConnection(rawWs: {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}): WSConnection {
  return {
    id: generateWSId(),
    send: (data) => rawWs.send(data),
    close: (code, reason) => rawWs.close(code, reason),
    metadata: {},
  };
}
