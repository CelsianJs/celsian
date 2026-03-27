// @celsian/rpc — Type-safe RPC

export type { RPCClientOptions } from "./client.js";
export { createRPCClient, RPCError } from "./client.js";
export { generateOpenAPI } from "./openapi.js";
export { createProcedure, procedure } from "./procedure.js";
export { RPCHandler, router } from "./router.js";

export type {
  ContextFactory,
  MiddlewareFunction,
  OpenAPISpec,
  ProcedureDefinition,
  ProcedureType,
  RouterDefinition,
  RPCContext,
  RPCManifest,
  RPCRequest,
  RPCResponse,
  TaggedValue,
} from "./types.js";
export { decode, encode } from "./wire.js";
