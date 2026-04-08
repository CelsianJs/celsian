// @celsian/core — Hook store + execution

import type { CelsianReply, CelsianRequest, HookHandler, OnErrorHandler } from "./types.js";

/** Storage for all lifecycle hook arrays in the 8-hook pipeline. */
export interface HookStore {
  onRequest: HookHandler[];
  preParsing: HookHandler[];
  preValidation: HookHandler[];
  preHandler: HookHandler[];
  preSerialization: HookHandler[];
  onSend: HookHandler[];
  onResponse: HookHandler[];
  onError: OnErrorHandler[];
}

/** Create an empty hook store with all lifecycle slots initialized. */
export function createHookStore(): HookStore {
  return {
    onRequest: [],
    preParsing: [],
    preValidation: [],
    preHandler: [],
    preSerialization: [],
    onSend: [],
    onResponse: [],
    onError: [],
  };
}

/** Shallow-clone a hook store for child plugin encapsulation contexts. */
export function cloneHookStore(source: HookStore): HookStore {
  return {
    onRequest: [...source.onRequest],
    preParsing: [...source.preParsing],
    preValidation: [...source.preValidation],
    preHandler: [...source.preHandler],
    preSerialization: [...source.preSerialization],
    onSend: [...source.onSend],
    onResponse: [...source.onResponse],
    onError: [...source.onError],
  };
}

/** Run hooks sequentially; short-circuit if any returns a Response or sets reply.sent. */
export async function runHooks(
  hooks: HookHandler[],
  request: CelsianRequest,
  reply: CelsianReply,
): Promise<Response | null> {
  for (const hook of hooks) {
    const result: unknown = await hook(request, reply);
    if (result instanceof Response) {
      return result;
    }
    if (reply.sent) {
      return reply.send(null);
    }
  }
  return null;
}

/**
 * Run hooks without aborting on reply.sent.
 * Used for onSend hooks where reply is already sent but
 * all hooks should still execute (e.g. CORS + timing + logging).
 */
export async function runOnSendHooks(
  hooks: HookHandler[],
  request: CelsianRequest,
  reply: CelsianReply,
): Promise<void> {
  for (const hook of hooks) {
    await hook(request, reply);
  }
}

/** Run hooks without awaiting -- errors are logged, not thrown. Used for onResponse. */
export function runHooksFireAndForget(
  hooks: HookHandler[],
  request: CelsianRequest,
  reply: CelsianReply,
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void },
): void {
  for (const hook of hooks) {
    try {
      const result = hook(request, reply);
      // If the hook returns a thenable, log errors instead of silently swallowing
      if (result && typeof (result as any).catch === "function") {
        (result as Promise<unknown>).catch((err: unknown) => {
          if (logger) {
            logger.error("fire-and-forget hook error", { error: err instanceof Error ? err.message : String(err) });
          } else {
            console.error("[celsian] fire-and-forget hook error:", err);
          }
        });
      }
    } catch {
      // Fire and forget — synchronous errors are intentionally ignored
    }
  }
}
