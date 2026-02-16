// @celsian/core — Hook store + execution

import type { HookHandler, OnErrorHandler, CelsianRequest, CelsianReply } from './types.js';

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

export function runHooksFireAndForget(
  hooks: HookHandler[],
  request: CelsianRequest,
  reply: CelsianReply,
): void {
  for (const hook of hooks) {
    try {
      hook(request, reply);
    } catch {
      // Fire and forget
    }
  }
}
