// @celsian/server — Hook-based server runtime on Web Standard APIs

export { CelsianApp, createApp } from './app.js';
export { createReply } from './reply.js';
export { Router } from './router.js';
export { defineConfig, loadConfig } from './config.js';

// Middleware
export { cors, rateLimit, jwtAuth, logger, etag, withETag, MemoryStore } from './middleware/index.js';
export type { CorsOptions, RateLimitOptions, RateLimitStore, JwtAuthOptions, JwtPayload, LoggerOptions, LogEntry, ETagOptions } from './middleware/index.js';

export type {
  CelsianConfig,
} from './config.js';

export { fp, kSkipOverride } from './types.js';

// SSE
export { createSSEStream, createSSEHub } from './sse.js';
export type { SSEEvent, SSEStreamOptions, SSEChannel, SSEHub } from './sse.js';

// WebSocket
export { WSRegistry, createRoom, wrapWebSocket, parseWSMessage, websocket } from './ws.js';
export type { WSHandler, WSSocket, WSMessage, WSRoute, WSRoom } from './ws.js';

// Tasks & Cron
export { createTaskQueue, createCronScheduler } from './tasks.js';
export type { TaskQueue, TaskJob, TaskPayload, TaskResult, TaskHandler, TaskDefinition, QueueStats, CronJob, CronScheduler } from './tasks.js';

export type {
  CelsianAppOptions,
  CelsianRequest,
  CelsianReply,
  HookName,
  HookHandler,
  OnErrorHandler,
  RouteMethod,
  RouteHandler,
  RouteOptions,
  RouteMatch,
  InternalRoute,
  PluginFunction,
  PluginOptions,
  PluginContext,
} from './types.js';
