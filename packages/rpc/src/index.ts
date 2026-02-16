// @celsian/rpc — Type-safe RPC

export { procedure, createProcedure } from './procedure.js';
export { router, RPCHandler } from './router.js';
export { createRPCClient, RPCError } from './client.js';
export { encode, decode } from './wire.js';
export { generateOpenAPI } from './openapi.js';

export type {
  RPCContext,
  ContextFactory,
  ProcedureType,
  ProcedureDefinition,
  MiddlewareFunction,
  RouterDefinition,
  RPCManifest,
  RPCRequest,
  RPCResponse,
  TaggedValue,
  OpenAPISpec,
} from './types.js';
export type { RPCClientOptions } from './client.js';
