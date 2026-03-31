// @celsian/core — Server runtime

export { CelsianApp, createApp } from "./app.js";
export type { CelsianConfig } from "./config.js";
export { defineConfig, loadConfig } from "./config.js";
export { EncapsulationContext } from "./context.js";
export type { CookieOptions } from "./cookie.js";
export { parseCookies, serializeCookie } from "./cookie.js";
export type { CronJob } from "./cron.js";
export { CronScheduler, parseCronExpression, shouldRun } from "./cron.js";
export {
  assertDecorationUnique,
  assertPlugin,
  CelsianError,
  HttpError,
  ValidationError,
  wrapNonError,
} from "./errors.js";
export type { HookStore } from "./hooks.js";
export { createHookStore, runHooks, runHooksFireAndForget, runOnSendHooks } from "./hooks.js";
export type { InjectOptions } from "./inject.js";
export { createInject } from "./inject.js";
export type { Logger, LoggerOptions, LogLevel } from "./logger.js";
export { createLogger, generateRequestId } from "./logger.js";
export { accepts, acceptsEncoding, acceptsLanguage } from "./negotiate.js";
export type { QueryMetric, RequestMetrics } from "./plugins/analytics.js";
export { dbAnalytics, dbTimingHeader, slowQueryLogger, trackedPool } from "./plugins/analytics.js";
export type { CORSOptions } from "./plugins/cors.js";
export { cors } from "./plugins/cors.js";
export type { CSRFOptions } from "./plugins/csrf.js";
export { csrf } from "./plugins/csrf.js";
export type { DatabaseOptions, DatabasePool, TransactionCapablePool, TransactionClient } from "./plugins/database.js";
export { database, transactionLifecycle, withTransaction } from "./plugins/database.js";
export type { ETagOptions } from "./plugins/etag.js";
export { withETag } from "./plugins/etag.js";
export type { OpenAPIOptions } from "./plugins/openapi.js";
export { openapi } from "./plugins/openapi.js";
export type { SecurityOptions } from "./plugins/security.js";
export { security } from "./plugins/security.js";
export type { QueueBackend, QueueMessage } from "./queue.js";
export { generateQueueId, MemoryQueue } from "./queue.js";
export { createReply } from "./reply.js";
export { buildRequest } from "./request.js";
export { Router } from "./router.js";
export type { ServeOptions, ServeResult } from "./serve.js";
export { nodeToWebRequest, serve, writeWebResponse } from "./serve.js";
export type { SSEChannel, SSEEvent, SSEHub, SSEStreamOptions } from "./sse.js";
export { createSSEHub, createSSEStream } from "./sse.js";
export type { TaskContext, TaskDefinition, TaskWorkerOptions } from "./task.js";
export { createEnqueue, TaskRegistry, TaskWorker } from "./task.js";
export type {
  CelsianAppOptions,
  CelsianReply,
  CelsianRequest,
  ExtractRouteParams,
  HookFunction,
  HookHandler,
  HookName,
  InternalRoute,
  OnErrorHandler,
  PluginContext,
  PluginFunction,
  PluginOptions,
  RouteHandler,
  RouteHooks,
  RouteManifestEntry,
  RouteMatch,
  RouteMethod,
  RouteOptions,
  RouteSchemaOptions,
  TypedCelsianRequest,
  TypedRouteHandler,
  TypedSchemaHandler,
} from "./types.js";
export type { WSConnection, WSHandler } from "./websocket.js";
export { createWSConnection, WSRegistry } from "./websocket.js";
