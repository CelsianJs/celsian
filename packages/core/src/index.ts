// @celsian/core, Server runtime

export { CelsianApp, createApp } from "./app.js";
export type { CelsianConfig } from "./config.js";
export { ConfigLoadError, defineConfig, loadConfig } from "./config.js";
export { EncapsulationContext } from "./context.js";
export type { CookieOptions, CookieSecurityContext } from "./cookie.js";
export {
  parseCookies,
  resetCookieSecurityWarnings,
  resolveSecureDefault,
  serializeCookie,
} from "./cookie.js";
export type { CronJob, ServerlessCronRuntime } from "./cron.js";
export { CronScheduler, detectServerlessCronRuntime, parseCronExpression, shouldRun } from "./cron.js";
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
export type { UploadedFile, UploadOptions } from "./plugins/upload.js";
export { upload } from "./plugins/upload.js";
export type {
  DeadLetterCapableQueue,
  DeadLetterEntry,
  QueueBackend,
  QueueMessage,
  TaskFailure,
} from "./queue.js";
export { DEFAULT_VISIBILITY_TIMEOUT, generateQueueId, MemoryQueue } from "./queue.js";
export { createReply } from "./reply.js";
export { buildRequest } from "./request.js";
export { isStatusKeyedResponseMap, resolveResponseSchema } from "./response-schema.js";
export { Router } from "./router.js";
export type { ServeOptions, ServeResult } from "./serve.js";
export { nodeToWebRequest, serve, writeWebResponse } from "./serve.js";
export type { SSEChannel, SSEEvent, SSEHub, SSEStreamOptions } from "./sse.js";
export { createSSEHub, createSSEStream } from "./sse.js";
export type { TaskContext, TaskDefinition, TaskFailureInfo, TaskWorkerOptions } from "./task.js";
export { createEnqueue, DEFAULT_TASK_TIMEOUT, TaskRegistry, TaskWorker } from "./task.js";
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
  ResponseSchemaMap,
  RouteHandler,
  RouteHooks,
  RouteManifestEntry,
  RouteMatch,
  RouteMethod,
  RouteOptions,
  RouteResponseSchema,
  RouteSchemaOptions,
  TypedCelsianRequest,
  TypedRouteHandler,
  TypedRouteOptions,
  TypedSchemaHandler,
} from "./types.js";
export type {
  WSAllowedOrigins,
  WSConnection,
  WSHandler,
  WSUpgradeDecision,
  WSUpgradeGuardOptions,
} from "./websocket.js";
export {
  authorizeWSUpgrade,
  checkWSOrigin,
  createWSConnection,
  WSConnectionLimiter,
  WSRegistry,
} from "./websocket.js";
