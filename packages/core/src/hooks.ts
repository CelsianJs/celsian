// @celsian/core, Hook store + execution

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

/** True for anything `await` would wait on: a promise, or any other object with a `then` method. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** A real promise for a thenable, so `.then()` on it behaves as `await` would. */
export function toPromise<T>(value: PromiseLike<T>): Promise<T> {
  return value instanceof Promise ? value : Promise.resolve(value);
}

/**
 * {@link runHooks} that only becomes asynchronous if a hook does.
 *
 * Same contract: hooks run in order, and the chain stops with a Response as
 * soon as one returns it or sets `reply.sent`. But while every hook returns a
 * plain value the answer comes back directly, with no promise and no tick.
 * The first hook to return a promise (or any thenable) switches the rest of
 * the chain to a promise. A hook that throws synchronously throws out of here.
 */
export function runHooksUntilAnswer(
  hooks: HookHandler[],
  request: CelsianRequest,
  reply: CelsianReply,
  from = 0,
): Response | null | Promise<Response | null> {
  for (let i = from; i < hooks.length; i++) {
    const result: unknown = (hooks[i] as HookHandler)(request, reply);
    if (isThenable(result)) {
      return toPromise(result).then((settled) => {
        if (settled instanceof Response) return settled;
        if (reply.sent) return reply.send(null);
        return runHooksUntilAnswer(hooks, request, reply, i + 1);
      });
    }
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
 * {@link runOnSendHooks} that only becomes asynchronous if a hook does.
 * Returns `undefined` when every hook finished synchronously.
 */
export function runOnSendHooksNow(
  hooks: HookHandler[],
  request: CelsianRequest,
  reply: CelsianReply,
  from = 0,
): Promise<void> | undefined {
  for (let i = from; i < hooks.length; i++) {
    const result: unknown = (hooks[i] as HookHandler)(request, reply);
    if (isThenable(result)) {
      return toPromise(result).then(() => runOnSendHooksNow(hooks, request, reply, i + 1));
    }
  }
  return undefined;
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
        (result as Promise<unknown>).catch((err: unknown) => reportHookError(err, logger));
      }
    } catch (err) {
      // A synchronous throw must not abort the remaining hooks, but it is still
      // a bug, report it through the same path as an async rejection instead of
      // letting it vanish.
      reportHookError(err, logger);
    }
  }
}

function reportHookError(
  err: unknown,
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void },
): void {
  if (logger) {
    logger.error("fire-and-forget hook error", { error: err instanceof Error ? err.message : String(err) });
  } else {
    console.error("[celsian] fire-and-forget hook error:", err);
  }
}
