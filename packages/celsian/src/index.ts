// celsian — Meta-package re-exports

// Core
export {
  createApp,
  CelsianApp,
  Router,
  createReply,
  serve,
  defineConfig,
  loadConfig,
  CelsianError,
  HttpError,
  ValidationError,
  createInject,
  createLogger,
  generateRequestId,
  cors,
  security,
  database,
  openapi,
  parseCookies,
  serializeCookie,
} from '@celsian/core';

export type {
  CelsianConfig,
  CelsianAppOptions,
  CelsianRequest,
  CelsianReply,
  RouteMethod,
  RouteHandler,
  RouteOptions,
  HookName,
  HookHandler,
  OnErrorHandler,
  PluginFunction,
  PluginOptions,
  PluginContext,
  ServeOptions,
  ServeResult,
  InjectOptions,
  Logger,
  LogLevel,
  LoggerOptions,
  CORSOptions,
  SecurityOptions,
  DatabaseOptions,
  DatabasePool,
  OpenAPIOptions,
  CookieOptions,
} from '@celsian/core';

// Schema
export {
  fromSchema,
  fromTypeBox,
  fromZod,
  fromValibot,
  coerceString,
  coerceQueryParams,
} from '@celsian/schema';

export type {
  StandardSchema,
  SchemaResult,
  SchemaIssue,
} from '@celsian/schema';
