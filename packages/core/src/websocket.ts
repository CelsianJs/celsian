// @celsian/core, WebSocket support (handler registry + upgrade authorization)

import { runHooks } from "./hooks.js";
import { createReply } from "./reply.js";
import { buildRequest } from "./request.js";
import type { CelsianRequest, HookHandler } from "./types.js";

/** WebSocket event handler with optional open, message, and close callbacks. */
export interface WSHandler {
  open?: (ws: WSConnection, req: CelsianRequest) => void;
  message?: (ws: WSConnection, data: string | ArrayBuffer) => void;
  close?: (ws: WSConnection, code: number, reason: string) => void;
}

/** A single WebSocket connection with send/close methods and a metadata bag. */
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

/**
 * Registry of WebSocket handlers and active connections, keyed by path.
 * Supports per-path and global broadcast.
 */
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

// ─── Upgrade Authorization ───
//
// WebSocket handshakes are NOT subject to the same-origin policy or CORS: a page
// on evil.com can open `new WebSocket('wss://victim.app/chat')` and the browser
// will attach victim.app's cookies. Without an Origin check that is a
// cross-site WebSocket hijacking (CSWSH) hole, so the check is on by default and
// defaults to same-origin.

/**
 * Origin allow-list for WebSocket upgrades. Accepts a single origin, a list of
 * origins, the literal `"*"` (any origin, opt in deliberately), or a predicate.
 */
export type WSAllowedOrigins = string | string[] | ((origin: string, request: Request) => boolean | Promise<boolean>);

/** Configuration for the WebSocket upgrade gate. */
export interface WSUpgradeGuardOptions {
  /**
   * Origins permitted to open a WebSocket. Default: same-origin only, the
   * `Origin` header's origin must match the request's own `Host`.
   */
  allowedOrigins?: WSAllowedOrigins;
  /**
   * Permit handshakes that send no `Origin` header at all (non-browser clients:
   * CLIs, service-to-service, load tests). Default: `false`. Browsers always
   * send `Origin` on a WebSocket handshake, so allowing it back in also
   * re-opens the hole to anything that can forge a socket, opt in knowingly.
   */
  allowMissingOrigin?: boolean;
  /** Legacy per-upgrade authentication callback. Runs after the Origin check. */
  onUpgrade?: (request: Request, pathname: string) => boolean | Promise<boolean>;
  /**
   * Run the app's root `onRequest` hooks (auth guards, rate limiters) on the
   * handshake. Default: `true`.
   */
  runRequestHooks?: boolean;
}

/** Outcome of the upgrade gate. `status` is the HTTP status to write when rejected. */
export interface WSUpgradeDecision {
  allowed: boolean;
  status: number;
  reason: string;
}

const UPGRADE_OK: WSUpgradeDecision = { allowed: true, status: 101, reason: "ok" };

/** Normalize an origin for comparison: lowercase, no trailing slash. */
function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim();
  return (trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed).toLowerCase();
}

/**
 * Validate the `Origin` header of a WebSocket handshake.
 * Rejects a missing Origin unless `allowMissingOrigin` is set.
 */
export async function checkWSOrigin(request: Request, options: WSUpgradeGuardOptions = {}): Promise<WSUpgradeDecision> {
  const rawOrigin = request.headers.get("origin");

  if (rawOrigin === null || rawOrigin === "") {
    if (options.allowMissingOrigin) return UPGRADE_OK;
    return {
      allowed: false,
      status: 403,
      reason: "WebSocket handshake has no Origin header. Set allowMissingOrigin: true to permit non-browser clients.",
    };
  }

  const origin = normalizeOrigin(rawOrigin);
  const allowed = options.allowedOrigins;

  // Predicate form, the caller owns the decision.
  if (typeof allowed === "function") {
    const ok = await allowed(rawOrigin, request);
    return ok ? UPGRADE_OK : { allowed: false, status: 403, reason: `Origin ${rawOrigin} rejected by allowedOrigins` };
  }

  if (allowed !== undefined) {
    const list = (Array.isArray(allowed) ? allowed : [allowed]).map(normalizeOrigin);
    if (list.includes("*")) return UPGRADE_OK;
    if (list.includes(origin)) return UPGRADE_OK;
    return { allowed: false, status: 403, reason: `Origin ${rawOrigin} is not in the allowedOrigins list` };
  }

  // Default: same-origin. Compare the Origin's authority against Host.
  const host = request.headers.get("host");
  if (!host) {
    return { allowed: false, status: 403, reason: "Cannot verify same-origin: request has no Host header" };
  }
  let originHost: string;
  try {
    originHost = new URL(rawOrigin).host.toLowerCase();
  } catch {
    return { allowed: false, status: 403, reason: `Malformed Origin header: ${rawOrigin}` };
  }
  if (originHost === host.trim().toLowerCase()) return UPGRADE_OK;

  return {
    allowed: false,
    status: 403,
    reason: `Cross-origin WebSocket handshake from ${rawOrigin} rejected (expected same-origin ${host}). Configure allowedOrigins to permit it.`,
  };
}

/**
 * Minimal shape of the app needed to authorize an upgrade. Declared structurally
 * so `websocket.ts` never imports `app.ts` (which imports this module).
 *
 * NOTE: root `onRequest` hooks are read through `rootContext`, which has no
 * public accessor on `CelsianApp` today. If one is added, switch to it.
 */
export interface WSUpgradeApp {
  rootContext?: { hooks?: { onRequest?: HookHandler[] } };
}

/** Read the app's root `onRequest` hook chain, tolerating an app that exposes none. */
function getRootOnRequestHooks(app: unknown): HookHandler[] {
  const hooks = (app as WSUpgradeApp | undefined)?.rootContext?.hooks?.onRequest;
  return Array.isArray(hooks) ? hooks : [];
}

/**
 * Full upgrade gate: Origin check, then the `onUpgrade` callback, then the app's
 * root `onRequest` hooks so auth guards and rate limiters apply to handshakes.
 *
 * A hook that returns a `Response` (or sends the reply) rejects the handshake
 * with that response's status.
 */
export async function authorizeWSUpgrade(
  app: unknown,
  request: Request,
  pathname: string,
  options: WSUpgradeGuardOptions = {},
): Promise<WSUpgradeDecision> {
  const originDecision = await checkWSOrigin(request, options);
  if (!originDecision.allowed) return originDecision;

  if (options.onUpgrade) {
    try {
      const ok = await options.onUpgrade(request, pathname);
      if (!ok) return { allowed: false, status: 403, reason: "onUpgrade callback rejected the handshake" };
    } catch (err) {
      return {
        allowed: false,
        status: 403,
        reason: `onUpgrade callback threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (options.runRequestHooks === false) return UPGRADE_OK;

  const hooks = getRootOnRequestHooks(app);
  if (hooks.length === 0) return UPGRADE_OK;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { allowed: false, status: 400, reason: "Malformed upgrade request URL" };
  }

  const celsianRequest = buildRequest(request, url, {});
  const reply = createReply();
  try {
    const early = await runHooks(hooks, celsianRequest, reply);
    if (early instanceof Response) {
      return {
        allowed: false,
        status: early.status,
        reason: `onRequest hook rejected the handshake (${early.status})`,
      };
    }
  } catch (err) {
    return {
      allowed: false,
      status: 500,
      reason: `onRequest hook threw during upgrade: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return UPGRADE_OK;
}

/**
 * Per-key (normally per-IP) cap on concurrent WebSocket connections.
 * A single client opening thousands of sockets is otherwise unbounded.
 */
export class WSConnectionLimiter {
  private counts = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Reserve a slot for `key`. Returns false when the cap is already reached. */
  acquire(key: string): boolean {
    if (this.max <= 0) return true;
    const current = this.counts.get(key) ?? 0;
    if (current >= this.max) return false;
    this.counts.set(key, current + 1);
    return true;
  }

  /** Release a previously acquired slot. */
  release(key: string): void {
    if (this.max <= 0) return;
    const current = this.counts.get(key) ?? 0;
    if (current <= 1) this.counts.delete(key);
    else this.counts.set(key, current - 1);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

/** Wrap a raw WebSocket (send/close) into a WSConnection with a generated ID and metadata bag. */
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
